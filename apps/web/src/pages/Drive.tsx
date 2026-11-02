import { speakable } from "@cc/voice/speakable";
import { type FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { type Api, ApiError, type NextApproval, type VoiceConfig } from "../api";
import { type LiveFeed, useLive } from "../live";
import { go } from "../router";
import { type Aliases, buildAliases, buildRoleBook, describeRole, parseCommand, resolveRole, type RoleBook, type RoleChoice, type VoiceMode } from "../voice/commands";
import { type Approval, type DriveState, driveReducer, type Expect, initialDriveState, listenTimeoutMs, type Say } from "../voice/machine";
import {
  BrowserListener,
  BrowserSpeaker,
  earcon,
  hasBrowserRecognition,
  hasRecorder,
  hasSynthesis,
  HeadsetButton,
  isIosStandalone,
  type Listener,
  loadVoices,
  pickVoice,
  RecorderListener,
  ScreenWakeLock,
  ServerSpeaker,
  type Speaker,
  VoicePermissionError,
} from "../voice/speech";

// Per-device preferences. Storage can be missing (private mode), so every access is guarded.
const PREFS = { mode: "cc.drive.mode", followUp: "cc.drive.followUp", serverVoice: "cc.drive.serverVoice", talkTo: "cc.drive.talkTo" };
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not persisted; still applies for this session
  }
}

/** The org root's role id (ROOT_ROLE_ID on the server): Dave's front door, and the default here. */
const CHIEF = "chief-of-staff";

const WORKING = "Working on it.";
const STILL_WORKING = "Still working on it.";
const CUE_EVERY_MS = 20_000;
const POLL_EVERY_MS = 4_000;

/** The main button: Interrupt while it talks, Send when it's Dave's turn. */
const PTT_LABEL: Record<DriveState["phase"], string> = {
  idle: "Talk",
  listening: "Send",
  sending: "Sending…",
  waiting: "Talk",
  speaking: "Interrupt",
};

const PHASE_LABEL: Record<DriveState["phase"], string> = {
  idle: "Tap to talk",
  listening: "Your turn: speak, then pause or tap Send",
  sending: "One moment…",
  waiting: "Working on it…",
  speaking: "Speaking…",
};

const readback = (action: "approve" | "reject", a: Approval) =>
  `To ${action}: ${a.summary.replace(/[.!?]+$/, "")}. Say "yes, ${action}" to confirm, or "no".`;

/**
 * Drive mode: hands-free Command Centre. One huge push-to-talk button (also
 * the headset / steering-wheel play-pause button), local voice commands, and
 * everything else sent to the agent in voice mode with its answer read aloud.
 */
export function Drive({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [state, dispatch] = useReducer(driveReducer, undefined, () =>
    initialDriveState(readPref(PREFS.mode) === "conversational" ? "conversational" : "push", readPref(PREFS.followUp) === "1"),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [aliases, setAliases] = useState<Aliases>(() => buildAliases([]));
  const [roles, setRoles] = useState<RoleBook>([]);
  /** Who new requests go to; null is the Chief of Staff, the default, who hands them on. Kept per device. */
  const [talkingTo, setTalkingTo] = useState<RoleChoice | null>(null);
  const talkingToRef = useRef(talkingTo);
  talkingToRef.current = talkingTo;
  const [preferServerVoice, setPreferServerVoice] = useState(readPref(PREFS.serverVoice) === "1");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [interim, setInterim] = useState("");
  const [wakeHeld, setWakeHeld] = useState(false);
  const [headset, setHeadset] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const lang = config?.language ?? "en-GB";

  // ----- set-up: server config, business names, voices, wake lock -----
  useEffect(() => {
    api.voiceConfig().then(setConfig).catch(() => setConfig({ stt: null, tts: null, maxUploadBytes: 0, maxSeconds: 30, language: "en-GB", calendar: false }));
    void (async () => {
      const verticals = await api.verticals().catch(() => []);
      const names = buildAliases(verticals);
      setAliases(names);
      const org = await api.org().catch(() => null);
      if (!org) return;
      const book = buildRoleBook(org, names);
      setRoles(book);
      // The role chosen last time on this device, if it still exists.
      try {
        const saved = JSON.parse(readPref(PREFS.talkTo) ?? "null") as { vertical: string; role: string } | null;
        const found = saved && book.find((r) => r.choice.vertical === saved.vertical && r.choice.role === saved.role);
        if (found && found.choice.role !== CHIEF) setTalkingTo(found.choice);
      } catch {
        // a bad saved value: stay automatic
      }
    })();
    void loadVoices().then(setVoices);
  }, [api]);

  useEffect(() => {
    const lock = new ScreenWakeLock();
    lock.onChange = setWakeHeld;
    void lock.acquire();
    return () => void lock.release();
  }, []);

  const listener = useMemo<Listener | null>(() => {
    const browser = hasBrowserRecognition();
    const server = Boolean(config?.stt) && hasRecorder();
    const transcribe = async (audio: Blob, seconds: number, language: string) => (await api.transcribe(audio, seconds, language)).text;
    // iOS home-screen apps expose SpeechRecognition without it working, so prefer the server there.
    if (browser && !(isIosStandalone() && server)) return new BrowserListener();
    if (server) return new RecorderListener(transcribe, Math.min(30, config?.maxSeconds ?? 30));
    return browser ? new BrowserListener() : null;
  }, [api, config]);

  const browserVoice = useMemo(() => pickVoice(voices, lang), [voices, lang]);
  const speaker = useMemo<Speaker | null>(() => {
    const server = config?.tts ? new ServerSpeaker((text) => api.speak(text)) : null;
    const browser = hasSynthesis() ? new BrowserSpeaker(browserVoice, lang) : null;
    if (server && (preferServerVoice || !browser || !browserVoice)) {
      // Fall back to the browser voice if the server one fails (offline, provider down).
      return {
        kind: "server",
        speak: (text) => server.speak(text).catch(() => browser?.speak(text)),
        cancel: () => {
          server.cancel();
          browser?.cancel();
        },
      } satisfies Speaker;
    }
    return browser ?? server;
  }, [api, config, browserVoice, lang, preferServerVoice]);

  const speakerRef = useRef(speaker);
  speakerRef.current = speaker;
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  const headsetRef = useRef<HeadsetButton | null>(null);
  useEffect(() => () => headsetRef.current?.stop(), []);

  // ----- following agent answers -----
  const watched = useRef(new Set<string>());
  const seenRuns = useRef(new Set<string>());
  /** Requests made in this session: when one runs again (a role reported back on work handed on), its new answer is spoken too. */
  const followed = useRef(new Set<string>());

  const say = useCallback((text: string, expect: Expect = "none", extra: Partial<Say> & { background?: boolean } = {}) => {
    dispatch({ type: "say", text, expect, ...extra });
  }, []);

  /** Speaks a watched task's new answer once it has one. */
  const check = useCallback(
    async (taskId: string) => {
      if (!watched.current.has(taskId)) return;
      const detail = await api.task(taskId).catch(() => null);
      if (!detail || detail.task.status === "queued" || detail.task.status === "running") return;
      const run = detail.runs.at(-1);
      if (run && seenRuns.current.has(run.id)) return;
      watched.current.delete(taskId);
      if (run) seenRuns.current.add(run.id);
      if (detail.task.status === "failed" || !run || run.status === "failed") {
        say("Sorry, that didn't work. It's in the inbox to retry.", "none", { background: true });
        void earcon("error");
        return;
      }
      const response = run.response ?? (run.result ? { text: speakable(run.result), type: "final" as const } : null);
      let text = response?.text || "Done.";
      if (detail.task.status === "awaiting_approval") text += " It needs your approval. Say read approvals.";
      const converse = response?.type === "converse";
      const followUp = stateRef.current.followUp;
      say(text, converse ? "reply" : followUp ? "command" : "none", { taskId, background: true });
    },
    [api, say],
  );

  useLive(feed, (m) => {
    if (m.type === "task.updated" && followed.current.has(m.task.id) && (m.task.status === "queued" || m.task.status === "running")) {
      watched.current.add(m.task.id);
    }
    if (m.type === "task.updated" && watched.current.has(m.task.id)) void check(m.task.id);
    if (m.type === "run.response" && watched.current.has(m.taskId)) void check(m.taskId);
  });

  // Polling backs up the live feed, which drops when the phone changes cell or tunnel.
  useEffect(() => {
    if (state.phase !== "waiting" || !state.waitingFor) return;
    const id = state.waitingFor;
    const timer = setInterval(() => void check(id), POLL_EVERY_MS);
    return () => clearInterval(timer);
  }, [state.phase, state.waitingFor, check]);

  // "Working on it", then a periodic cue on long runs.
  useEffect(() => {
    if (state.phase !== "waiting") return;
    void speakerRef.current?.speak(WORKING);
    const timer = setInterval(() => void speakerRef.current?.speak(STILL_WORKING), CUE_EVERY_MS);
    return () => {
      clearInterval(timer);
      speakerRef.current?.cancel();
    };
  }, [state.phase]);

  // ----- doing what was said -----
  const readNext = useCallback(
    async (skip: string[], prefix = "") => {
      let next: NextApproval;
      try {
        next = await api.nextApproval(skip);
      } catch {
        say(`${prefix}I couldn't load the approvals.`.trim());
        return;
      }
      if (!next.proposal) {
        say(`${prefix}${next.text}`.trim());
        return;
      }
      say(`${prefix}${next.text}`.trim(), "approval", { approval: { proposalId: next.proposal.id, summary: speakable(next.proposal.summary, { maxChars: 220, more: "" }) } });
    },
    [api, say],
  );

  const decide = useCallback(
    async (action: "approve" | "reject", proposalId: string) => {
      try {
        const result = await (action === "approve" ? api.approve(proposalId) : api.reject(proposalId));
        const done = action === "reject" ? "Rejected." : result.status === "failed" ? "Approved, but it failed to run. Check it when you're parked." : "Approved.";
        void earcon("done");
        await readNext(stateRef.current.skipped, `${done} `);
      } catch (err) {
        const text = err instanceof ApiError && err.status === 409 ? "That one was already decided." : `Sorry, I couldn't ${action} it.`;
        say(text);
      }
    },
    [api, readNext, say],
  );

  const chooseRole = useCallback((picked: RoleChoice | null) => {
    // The Chief of Staff is the default, not a separate choice.
    const choice = picked?.role === CHIEF ? null : picked;
    writePref(PREFS.talkTo, choice ? JSON.stringify({ vertical: choice.vertical, role: choice.role }) : "null");
    setTalkingTo(choice);
  }, []);

  const setMode = useCallback((mode: VoiceMode) => {
    writePref(PREFS.mode, mode);
    dispatch({ type: "mode", mode });
  }, []);

  const handle = useCallback(
    async (utterance: string) => {
      const s = stateRef.current;
      const cmd = parseCommand(utterance, aliases, roles);
      if (!cmd) {
        dispatch({ type: "end" });
        return;
      }
      // While the agent waits for an answer, only conversation controls are commands; the rest is the answer.
      const replying = s.expect === "reply" && s.conversation;
      const control = cmd.kind === "stop" || cmd.kind === "cancel" || cmd.kind === "end" || cmd.kind === "repeat" || cmd.kind === "mode";
      if (replying && !control) {
        try {
          const task = await api.replyToTask(s.conversation!.taskId, utterance.trim(), true);
          watched.current.add(task.id);
          dispatch({ type: "waiting", taskId: task.id });
        } catch (err) {
          say(`Sorry, I couldn't send that. ${(err as Error).message}`);
        }
        return;
      }

      switch (cmd.kind) {
        case "stop":
          speakerRef.current?.cancel();
          dispatch({ type: "end" });
          void earcon("done");
          return;
        case "cancel":
          dispatch({ type: "end" });
          say("Cancelled.");
          return;
        case "end":
          dispatch({ type: "end" });
          say("Okay. Talk later.");
          return;
        case "repeat":
          say(s.lastSpoken ?? "There's nothing to repeat yet.", s.lastSpoken ? s.expect : "none");
          return;
        case "mode":
          setMode(cmd.mode);
          say(cmd.mode === "conversational" ? "Conversation mode. I'll listen after each question." : "Push to talk. Press the button when you want me.");
          return;
        case "briefing":
          try {
            say((await api.voiceBriefing()).text, s.followUp ? "command" : "none");
          } catch {
            say("I couldn't get the briefing.");
          }
          return;
        case "approvals":
          dispatch({ type: "resetSkips" });
          await readNext([]);
          return;
        case "next": {
          const skip = s.approval ? [...s.skipped, s.approval.proposalId] : s.skipped;
          if (s.approval) dispatch({ type: "skip", proposalId: s.approval.proposalId });
          await readNext(skip);
          return;
        }
        case "approve":
        case "reject": {
          let approval = s.expect === "approval" || s.expect === "confirm" ? s.approval : null;
          if (!approval) {
            const next = await api.nextApproval(s.skipped).catch(() => null);
            if (!next?.proposal) {
              say("Nothing is waiting for approval.");
              return;
            }
            approval = { proposalId: next.proposal.id, summary: speakable(next.proposal.summary, { maxChars: 220, more: "" }) };
          }
          say(readback(cmd.kind, approval), "confirm", { approval, confirm: { ...approval, action: cmd.kind } });
          return;
        }
        case "confirm":
          if (s.expect === "confirm" && s.confirm?.action === cmd.action) {
            await decide(cmd.action, s.confirm.proposalId);
          } else if (s.expect === "confirm" && s.confirm) {
            say(`You asked to ${s.confirm.action}. Say "yes, ${s.confirm.action}", or "no".`, "confirm");
          } else say("There's nothing to confirm.");
          return;
        case "deny":
          if (s.expect === "confirm") say("Okay, left as it is. Say next, or approve or reject.", "approval");
          else say("Okay.");
          return;
        case "whoami": {
          const current = talkingToRef.current;
          say(
            current ? `You're talking to ${describeRole(current)}.` : "You're talking to the Chief of Staff, who passes things to the right role and tells you the outcome.",
            s.followUp ? "command" : "none",
          );
          return;
        }
        case "talkTo": {
          const found = resolveRole(cmd.target, roles);
          if (found.kind === "auto" || (found.kind === "role" && found.choice.role === CHIEF)) {
            chooseRole(null);
            say("You're talking to the Chief of Staff. Go ahead.", "command");
          } else if (found.kind === "role") {
            chooseRole(found.choice);
            say(`You're talking to ${describeRole(found.choice)}. Go ahead.`, "command");
          } else if (found.kind === "ambiguous") {
            const options = found.options.map((o) => (o.business ? `${o.business} ${o.title}` : o.title));
            say(`Which one: ${options.slice(0, -1).join(", ")} or ${options.at(-1)}?`, "command");
          } else {
            say(`I don't know who ${cmd.target} is. Say chief of staff, or a business and a role, like shop customer support.`, "command");
          }
          return;
        }
        case "chat":
          try {
            // A role named in the request wins; a business named on its own means that business, not the chosen role.
            const current = talkingToRef.current;
            const target = cmd.role ? { vertical: cmd.vertical, role: cmd.role } : cmd.vertical ? { vertical: cmd.vertical } : current ? { vertical: current.vertical, role: current.role } : {};
            const { task } = await api.chat(cmd.text, target.vertical, { voice: true, role: target.role });
            watched.current.add(task.id);
            followed.current.add(task.id);
            dispatch({ type: "waiting", taskId: task.id });
          } catch (err) {
            say(`Sorry, I couldn't send that. ${(err as Error).message}`);
          }
      }
    },
    [aliases, api, chooseRole, decide, readNext, roles, say, setMode],
  );

  // ----- side effects of the state machine -----
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    if (state.phase !== "listening") return;
    const l = listenerRef.current;
    if (!l) {
      dispatch({ type: "error", message: "No speech recognition here. Type a command below." });
      return;
    }
    let live = true;
    setInterim("");
    void (async () => {
      await earcon(stateRef.current.expect === "none" || stateRef.current.expect === "command" ? "listen" : "turn");
      if (!live) return;
      try {
        const text = await l.listen({ lang: langRef.current, timeoutMs: listenTimeoutMs(stateRef.current), onInterim: setInterim });
        if (!live) return;
        if (text) {
          dispatch({ type: "heard", text });
          setInterim(text);
          await handleRef.current(text);
        } else dispatch({ type: "silence" });
      } catch (err) {
        if (!live) return;
        const message =
          err instanceof VoicePermissionError
            ? "I can't use the microphone. Allow microphone access for this site in the browser settings."
            : (err as Error).message;
        dispatch({ type: "error", message });
        void earcon("error");
      }
    })();
    return () => {
      live = false;
      l.stop();
    };
  }, [state.phase, state.seq]);

  useEffect(() => {
    if (state.phase !== "speaking" || !state.utterance) return;
    const s = speakerRef.current;
    if (!s) {
      dispatch({ type: "spoken" });
      return;
    }
    let live = true;
    void s.speak(state.utterance).finally(() => live && dispatch({ type: "spoken" }));
    return () => {
      live = false;
      s.cancel();
    };
  }, [state.phase, state.seq, state.utterance]);

  // ----- input -----
  /** The main button: Talk, Interrupt while speaking, Send while listening. */
  const press = useCallback((source: "screen" | "headset" = "screen") => {
    setNotice(null);
    if (!headsetRef.current) {
      headsetRef.current = new HeadsetButton(() => pressRef.current("headset"));
    }
    // Started from a tap, as autoplay rules require; then the headset button works too.
    if (!headsetRef.current.active) void headsetRef.current.start().then(() => setHeadset(headsetRef.current?.active ?? false));
    const s = stateRef.current;
    if (s.phase === "listening") {
      listenerRef.current?.stop(); // Send: finish now; what was heard is still used
      return;
    }
    if (s.phase === "sending") return;
    // The phone pauses media (firing the headset handler) when it starts talking: never let
    // that cut an answer off. Interrupting is the screen button's job.
    if (s.phase === "speaking" && source === "headset") return;
    dispatch({ type: "press", source });
  }, []);
  const pressRef = useRef(press);
  pressRef.current = press;

  const submitTyped = async (e: FormEvent) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text || state.phase === "sending") return;
    setTyped("");
    speakerRef.current?.cancel();
    dispatch({ type: "press" });
    dispatch({ type: "heard", text });
    setInterim(text);
    await handle(text);
  };

  const tapDecision = (action: "approve" | "reject") => {
    const s = stateRef.current;
    if (s.expect === "confirm" && s.confirm?.action === action) {
      speakerRef.current?.cancel();
      void decide(action, s.confirm.proposalId);
      return;
    }
    if (s.approval) say(readback(action, s.approval), "confirm", { approval: s.approval, confirm: { ...s.approval, action } });
  };

  const toggleFollowUp = (on: boolean) => {
    writePref(PREFS.followUp, on ? "1" : "0");
    dispatch({ type: "followUp", on });
  };

  const exit = () => {
    speakerRef.current?.cancel();
    listenerRef.current?.stop();
    go("chat");
  };

  const caption = state.phase === "listening" || state.phase === "sending" ? interim : (state.utterance ?? state.lastSpoken ?? "");
  const busy = state.phase === "sending";

  return (
    <section className={`drive phase-${state.phase}`} aria-label="Drive mode">
      <header className="drive-bar">
        <button type="button" className="drive-exit" onClick={exit}>
          Exit
        </button>
        <div className="drive-modes" role="group" aria-label="Voice mode">
          <button type="button" aria-pressed={state.mode === "push"} className={state.mode === "push" ? "primary" : ""} onClick={() => setMode("push")}>
            Push to talk
          </button>
          <button
            type="button"
            aria-pressed={state.mode === "conversational"}
            className={state.mode === "conversational" ? "primary" : ""}
            onClick={() => setMode("conversational")}
          >
            Conversation
          </button>
        </div>
      </header>

      {roles.length > 0 && (
        <label className="drive-talkto">
          <span>Talking to</span>
          <select
            value={talkingTo ? `${talkingTo.vertical}/${talkingTo.role}` : ""}
            onChange={(e) => chooseRole(roles.find((r) => `${r.choice.vertical}/${r.choice.role}` === e.target.value)?.choice ?? null)}
          >
            <option value="">Chief of Staff (hands it on)</option>
            {groupRoles(roles).map(([business, choices]) =>
              business ? (
                <optgroup key={business} label={business}>
                  {choices.map((c) => (
                    <option key={`${c.vertical}/${c.role}`} value={`${c.vertical}/${c.role}`}>
                      {c.title}
                    </option>
                  ))}
                </optgroup>
              ) : (
                choices.map((c) => (
                  <option key={`${c.vertical}/${c.role}`} value={`${c.vertical}/${c.role}`}>
                    {c.title}
                  </option>
                ))
              ),
            )}
          </select>
        </label>
      )}

      <p className="drive-state" role="status" aria-live="polite" data-phase={state.phase}>
        {PHASE_LABEL[state.phase]}
        {state.conversation && state.expect === "reply" && state.phase === "idle" ? " (your answer)" : ""}
      </p>

      <button
        type="button"
        className={`drive-ptt ${state.phase}`}
        onClick={() => press("screen")}
        disabled={busy}
        aria-label={PTT_LABEL[state.phase]}
      >
        <span className="drive-ptt-inner">
          {state.phase === "speaking" ? <StopIcon /> : state.phase === "listening" ? <SendIcon /> : <MicIcon />}
          <span className="drive-ptt-label">{PTT_LABEL[state.phase]}</span>
        </span>
      </button>

      <p className="drive-caption" aria-live="polite">
        {caption}
      </p>

      {state.expect === "confirm" && state.confirm && (
        <div className="drive-actions" role="group" aria-label="Confirm">
          <button type="button" className="primary" onClick={() => tapDecision(state.confirm!.action)}>
            Yes, {state.confirm.action}
          </button>
          <button type="button" onClick={() => say("Okay, left as it is.", "approval")}>
            No
          </button>
        </div>
      )}
      {state.expect === "approval" && state.approval && (
        <div className="drive-actions" role="group" aria-label="Approval">
          <button type="button" onClick={() => tapDecision("approve")}>
            Approve
          </button>
          <button type="button" onClick={() => tapDecision("reject")}>
            Reject
          </button>
          <button type="button" onClick={() => void handle("next")}>
            Next
          </button>
        </div>
      )}

      {(state.error || notice) && (
        <p className="drive-error" role="alert">
          {state.error ?? notice}
        </p>
      )}

      <details className="drive-more">
        <summary>Options</summary>
        <form className="row" onSubmit={submitTyped}>
          <input
            className="grow"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type a command"
            aria-label="Type a command"
          />
          <button type="submit">Send</button>
        </form>
        <label className="row small">
          <input type="checkbox" checked={state.followUp} onChange={(e) => toggleFollowUp(e.target.checked)} />
          Listen for a follow-up after each answer (conversation mode)
        </label>
        {config?.tts && (
          <label className="row small">
            <input
              type="checkbox"
              checked={preferServerVoice}
              onChange={(e) => {
                writePref(PREFS.serverVoice, e.target.checked ? "1" : "0");
                setPreferServerVoice(e.target.checked);
              }}
            />
            Use the server voice ({config.tts.provider})
          </label>
        )}
        <p className="muted small">
          Listening: {listener ? (listener.kind === "browser" ? "browser" : `server (${config?.stt?.provider})`) : "unavailable"} · Voice:{" "}
          {speaker ? (speaker.kind === "browser" ? (browserVoice?.name ?? "browser default") : config?.tts?.provider) : "unavailable"} · Screen:{" "}
          {wakeHeld ? "kept on" : "may sleep"} · Headset button: {headset ? "on" : "tap once to enable"}
        </p>
        <p className="muted small">
          Say "what's new", "read approvals", "approve", "next", "repeat", "stop", or a request like "shop: has order 1042 shipped?". Say
          "talk to the shop lead" to talk to one role ("back to chief of staff" for the default, who hands things on and reports back),
          "who am I talking to?", or ask one role once: "ask customer support whether order 1042 shipped".
        </p>
      </details>
    </section>
  );
}

/** Each business's roles in org-chart order (the Chief of Staff is the default option, not listed). */
function groupRoles(book: RoleBook): [string, RoleChoice[]][] {
  const groups = new Map<string, RoleChoice[]>();
  for (const { choice } of book) if (choice.role !== CHIEF) groups.set(choice.business, [...(groups.get(choice.business) ?? []), choice]);
  return [...groups];
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"
      />
    </svg>
  );
}
