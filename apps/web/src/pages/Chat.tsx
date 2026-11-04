import type { AgentMessage, Proposal, Task } from "@cc/core";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Api, ChatFile } from "../api";
import { type LiveFeed, useLive } from "../live";
import { Icon } from "../icons";
import { Empty, ErrorBanner, PageHead, VTag } from "../ui";
import { ProposalCard } from "./Approvals";
import { Transcript } from "./Transcript";
import { AttachedFiles, Composer } from "../composer";
import { clearChat, loadChat, messagesByTurn, saveChat } from "../chat-store";
import { useStickToBottom } from "../scroll";
import { ErrorReport } from "../copy";
import { ReadAloudToggle, useReadAloud } from "../voice/readAloud";
import { Drive } from "./Drive";

type Turn = { key: number; text: string; files?: { name: string; size: number }[]; task: Task; messages: AgentMessage[]; result?: string; /** Server time it was taken (see chat-store). */ at: string };

/** A task in these states has answered, so a follow-up can continue it. */
const REPLYABLE: Task["status"][] = ["done", "awaiting_approval", "failed"];

/** Applies `f` to the latest turn on `taskId` (a task's follow-ups each have their own turn). */
function onLatest(ts: Turn[], taskId: string, f: (t: Turn) => Turn): Turn[] {
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i]!.task.id === taskId) return ts.map((t, j) => (j === i ? f(t) : t));
  return ts;
}

type Queued = { id: number; text: string; files: ChatFile[] };
let queueId = 0;

type Chain = { taskIds: string[]; proposals: Proposal[] };

/**
 * The approvals of a chat thread, wherever the work went: the task's own and those of every role
 * it handed off to. Kept live: an update to a known proposal patches it in place, and anything
 * new in the chain (a handoff starting, a proposal from a role we haven't seen yet) refetches.
 */
function useChainProposals(api: Api, feed: LiveFeed, taskIds: string[]) {
  const [chains, setChains] = useState<Record<string, Chain>>({});
  const known = useRef(chains);
  known.current = chains;
  const ids = taskIds.join(",");

  const refresh = useCallback(
    (only?: string[]) => {
      for (const id of only ?? taskIds) {
        api
          .chainProposals(id)
          .then((chain) => setChains((cs) => ({ ...cs, [id]: chain })))
          .catch(() => {});
      }
    },
    [api, ids],
  );
  useEffect(() => refresh(), [refresh]);

  useLive(feed, (m) => {
    if (m.type === "proposal.updated") {
      const p = m.proposal;
      const owners = Object.entries(known.current).filter(([, c]) => p.taskId && c.taskIds.includes(p.taskId));
      if (!owners.length) return refresh(); // maybe from a role a thread just handed work to
      setChains((cs) => {
        const next = { ...cs };
        for (const [id, c] of owners) {
          const has = c.proposals.some((x) => x.id === p.id);
          next[id] = { ...c, proposals: has ? c.proposals.map((x) => (x.id === p.id ? p : x)) : [...c.proposals, p] };
        }
        return next;
      });
    }
    if (m.type === "task.updated" && !Object.values(known.current).some((c) => c.taskIds.includes(m.task.id))) {
      refresh(); // a new handoff task joins a chain
    }
  });
  return chains;
}

/**
 * Talk to the command agent. The first message becomes a task; follow-ups
 * continue it (the agent resumes its session) until "New chat". Replies stream in live.
 */
/** How long the composer takes to grow into Drive mode, or shrink back (matches styles.css). */
const DRIVE_MS = 450;
type DriveStage = "off" | "opening" | "open" | "closing";

/**
 * Drive mode in the chat composer: while `want` is set, the composer comes out of the page flow
 * (a spacer keeps its place) and grows upwards, its bottom edge where it was, until its top edge
 * reaches just under the top bar; a panel above the text box (.composer-panel) takes the extra
 * height and holds Drive. Clearing `want` shrinks it back first. The sizes go to CSS as variables on
 * the chat section: --drive-left/-width/-bottom (where the box sits), --drive-h (the panel's
 * height, animated by a transition) and --drive-spacer (the box's height in the page).
 */
function useDriveExpand(sectionRef: RefObject<HTMLElement | null>, want: boolean): DriveStage {
  const [stage, setStage] = useState<DriveStage>("off");
  const geom = useRef({ startH: 0, restH: 0, bottom: 0, openH: 0 });

  /** The panel's open height: what's left between the top bar and the box's bottom edge. */
  const fit = (el: HTMLElement) => {
    const g = geom.current;
    const box = el.querySelector<HTMLElement>(".composer");
    const panel = el.querySelector<HTMLElement>(".composer-panel");
    // The rest of the box (rows, padding) as laid out in Drive mode, without the panel.
    if (box && panel) g.restH = box.getBoundingClientRect().height - panel.getBoundingClientRect().height;
    const top = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) + 8;
    g.openH = Math.max(g.startH, window.innerHeight - g.bottom - top - g.restH);
  };

  /** Where the box goes for a given horizontal extent: up to just under the top bar. */
  const place = (el: HTMLElement, left: number, width: number) => {
    const g = geom.current;
    el.style.setProperty("--drive-left", `${left}px`);
    el.style.setProperty("--drive-width", `${width}px`);
    el.style.setProperty("--drive-bottom", `${g.bottom}px`);
  };

  useLayoutEffect(() => {
    const el = sectionRef.current;
    const box = el?.querySelector<HTMLElement>(".composer");
    if (!el || !box) return;
    if (want && stage === "off") {
      // Measured in place, before it moves; the panel starts empty and takes all the extra height.
      const r = box.getBoundingClientRect();
      geom.current = { startH: 0, restH: r.height, bottom: window.innerHeight - r.bottom, openH: 0 };
      el.style.setProperty("--drive-spacer", `${r.height}px`);
      el.style.setProperty("--drive-h", "0px");
      place(el, r.left, r.width);
      setStage("opening");
    } else if (want && stage === "closing") {
      el.style.setProperty("--drive-h", `${geom.current.openH}px`);
      setStage("opening");
    } else if (!want && (stage === "opening" || stage === "open")) {
      el.style.setProperty("--drive-h", `${geom.current.startH}px`);
      setStage("closing");
    }
  }, [want, stage]);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (stage === "opening") {
      // Grow on the next frame, from the box as Drive mode lays it out (the panel still empty).
      fit(el);
      const frame = requestAnimationFrame(() => el.style.setProperty("--drive-h", `${geom.current.openH}px`));
      const timer = setTimeout(() => setStage("open"), DRIVE_MS);
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
      };
    }
    if (stage === "closing") {
      // Back to the text box once the panel has shrunk (straight away if there's no animation).
      const panel = el.querySelector<HTMLElement>(".composer-panel");
      const done = () => setStage("off");
      if (!panel || getComputedStyle(panel).transitionDuration.split(",").every((d) => parseFloat(d) === 0)) {
        done();
        return;
      }
      const onEnd = (e: TransitionEvent) => {
        if (e.target === panel && e.propertyName === "height") done();
      };
      panel.addEventListener("transitionend", onEnd);
      const timer = setTimeout(done, DRIVE_MS * 4);
      return () => {
        panel.removeEventListener("transitionend", onEnd);
        clearTimeout(timer);
      };
    }
    if (stage === "open") {
      // Keep it fitted when the window changes size (a phone turning, the keyboard).
      const refit = () => {
        const spacer = el.querySelector<HTMLElement>(".composer-spacer")?.getBoundingClientRect();
        if (!spacer) return;
        place(el, spacer.left, spacer.width);
        fit(el);
        el.style.setProperty("--drive-h", `${geom.current.openH}px`);
      };
      window.addEventListener("resize", refit);
      return () => window.removeEventListener("resize", refit);
    }
  }, [stage]);

  return stage;
}

export function Chat({ api, feed, drive = false }: { api: Api; feed: LiveFeed; drive?: boolean }) {
  const [verticals, setVerticals] = useState<{ id: string; name: string }[]>([]);
  const [vertical, setVertical] = useState("");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The task follow-ups continue; null starts a new one. */
  const [threadId, setThreadId] = useState<string | null>(null);
  const readAloud = useReadAloud(api);
  const sectionRef = useRef<HTMLElement>(null);
  const driveStage = useDriveExpand(sectionRef, drive);
  const driving = driveStage !== "off";
  /** Drive's typed-command handler while it's open (Drive sets it). */
  const driveCommand = useRef<((text: string) => void) | null>(null);
  /** Where Converse puts its Push to talk switch (the row of buttons) and its Talking to picker (in place of Send to). */
  const [driveToolbar, setDriveToolbar] = useState<HTMLElement | null>(null);
  const [drivePicker, setDrivePicker] = useState<HTMLElement | null>(null);

  useEffect(() => {
    api.verticals().then(setVerticals).catch(() => {});
  }, [api]);

  // The conversation outlives the page: restore it (replies fetched again from its tasks) ...
  const [restoring, setRestoring] = useState(() => loadChat() !== null);
  useEffect(() => {
    const saved = loadChat();
    if (!saved) return;
    setVertical(saved.vertical);
    setThreadId(saved.threadId);
    let cancelled = false;
    void (async () => {
      const ids = [...new Set(saved.turns.map((t) => t.taskId))];
      const details = new Map(await Promise.all(ids.map(async (id) => [id, await api.task(id).catch(() => null)] as const)));
      if (cancelled) return;
      const restored: Turn[] = [];
      for (const id of ids) {
        const detail = details.get(id);
        if (!detail) continue; // the task is gone: drop its turns
        const mine = saved.turns.map((t, i) => ({ t, i })).filter(({ t }) => t.taskId === id);
        const messages = messagesByTurn(mine.map(({ t }) => t), detail.runs);
        mine.forEach(({ t, i }, n) => restored.push({ key: i, text: t.text, files: t.files, task: detail.task, messages: messages[n]!, at: t.at }));
      }
      restored.sort((a, b) => a.key - b.key);
      // Turns sent while restoring stay after the restored ones.
      setTurns((live) => [...restored, ...live.map((t, n) => ({ ...t, key: restored.length + n }))]);
      setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // ... and save it on every change: what was sent, where, and when there was last activity.
  useEffect(() => {
    if (restoring) return;
    saveChat({ threadId, vertical, lastActive: Date.now(), turns: turns.map((t) => ({ text: t.text, ...(t.files?.length ? { files: t.files } : {}), taskId: t.task.id, at: t.at })) });
  }, [turns, threadId, vertical, restoring]);

  /** "New chat": a clean screen and a new thread. */
  const newChat = () => {
    readAloud.stop();
    setQueue([]);
    clearChat();
    setTurns([]);
    setThreadId(null);
    setError(null);
  };

  // Proposals show inline on the latest turn of each task (follow-ups continue the same task).
  const latestTurnOf = new Map(turns.map((t) => [t.task.id, t.key]));
  const chains = useChainProposals(api, feed, [...latestTurnOf.keys()]);

  // Newest at the bottom, followed as it streams in (unless scrolled up to read).
  const lastTurn = turns[turns.length - 1];
  useStickToBottom(`${turns.length}:${lastTurn?.messages.length ?? 0}:${lastTurn?.task.status ?? ""}:${Object.values(chains).reduce((n, c) => n + c.proposals.length, 0)}`, !restoring);

  useLive(feed, (m) => {
    if (m.type === "run.message") {
      if (m.message.type === "text") readAloud.offer(m.message.text);
      setTurns((ts) => onLatest(ts, m.taskId, (t) => ({ ...t, messages: [...t.messages, m.message] })));
    }
    if (m.type === "task.updated") {
      setTurns((ts) => onLatest(ts, m.task.id, (t) => ({ ...t, task: m.task })));
    }
  });

  /** The thread's latest task, and whether it has answered (so a follow-up can continue it). */
  const thread = threadId ? turns.findLast((t) => t.task.id === threadId)?.task : undefined;
  const ready = !thread || REPLYABLE.includes(thread.status);

  /** Messages written while the agent is still working: each is sent, in order, once it has answered. */
  const [queue, setQueue] = useState<Queued[]>([]);
  const sending = useRef(false);
  useEffect(() => {
    if (!ready || sending.current || !queue.length || restoring) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    sending.current = true;
    void dispatch(next!.text, next!.files, false).then((ok) => {
      sending.current = false;
      if (!ok) setQueue([]); // the rest would only fail the same way; the error is shown
    });
  });

  const send = async (message: string, files: ChatFile[]) => {
    // In Drive mode, typing is another way to give Drive a command.
    if (driving && driveCommand.current) {
      driveCommand.current(message);
      setText("");
      return true;
    }
    if (!ready || queue.length) {
      setQueue((q) => [...q, { id: ++queueId, text: message, files }]);
      setText("");
      setError(null);
      return true;
    }
    return dispatch(message, files, true);
  };

  /** Sends now. `restore`: on failure, put the message back in the box (not for a queued one). */
  const dispatch = async (message: string, files: ChatFile[], restore: boolean) => {
    if (restore) setText("");
    setError(null);
    const ids = files.map((f) => f.id);
    try {
      const task = threadId ? await api.replyToTask(threadId, message, false, ids) : (await api.chat(message, vertical || undefined, { files: ids })).task;
      setThreadId(task.id);
      // A follow-up's task timestamp is when the server took the reply; a new chat's is its creation.
      const shown = files.map((f) => ({ name: f.name, size: f.size }));
      setTurns((ts) => [...ts, { key: ts.length, text: message, ...(shown.length ? { files: shown } : {}), task, messages: [], at: threadId ? task.updatedAt : task.createdAt }]);
      return true;
    } catch (err) {
      setError(restore ? (err as Error).message : `Couldn't send the queued message "${message.slice(0, 60)}": ${(err as Error).message}`);
      if (restore) setText(message);
      return false;
    }
  };

  return (
    <section ref={sectionRef} className="chat">
      <PageHead
        title="Chat"
        sub="You're talking to the Chief of Staff, who hands work to the right role and tells you the outcome here. Follow-ups continue the chat until you start a new one."
      />
      <div className="turns">
        {turns.length === 0 && (
          <Empty icon="chat">
            Ask anything: the Chief of Staff answers, or passes it to the right role and reports back here. To go straight to a
            business, start with its name ("dms: …") or pick it below.
          </Empty>
        )}
        {turns.map((t) => (
          <div key={t.key} className="turn">
            <div className="bubble me">
              {t.text}
              <AttachedFiles files={t.files ?? []} />
            </div>
            <div className="bubble agent">
              <div className="row between small">
                <VTag id={t.task.vertical} />
                <a className={`status ${t.task.status}`} href={`#/task/${t.task.id}`} title="Open the task">
                  {t.task.status.replace("_", " ")}
                </a>
              </div>
              <Transcript messages={t.messages} />
              {t.task.status === "failed" && latestTurnOf.get(t.task.id) === t.key && (
                <ErrorReport
                  title="This didn't finish"
                  error={t.task.note ?? "The agent's run failed without a message. Open the task for details."}
                  facts={[["Task", t.task.id], ["Business", t.task.vertical], ["Role", t.task.role], ["Asked", t.text.slice(0, 200)]]}
                />
              )}
              {latestTurnOf.get(t.task.id) === t.key && <InlineProposals api={api} proposals={chains[t.task.id]?.proposals ?? []} />}
            </div>
          </div>
        ))}
        {queue.map((q) => (
          <div key={q.id} className="turn queued">
            <div className="bubble me">
              {q.text}
              <AttachedFiles files={q.files.map((f) => ({ name: f.name, size: f.size }))} />
              <div className="row between small">
                <span className="muted">Queued: sends when the agent has answered</span>
                <button type="button" onClick={() => setQueue((all) => all.filter((x) => x.id !== q.id))} aria-label={`Cancel queued message: ${q.text.slice(0, 40)}`}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {driving && <div className="composer-spacer" aria-hidden="true" />}
      <Composer
        api={api}
        value={text}
        onChange={setText}
        onSend={send}
        label="Message"
        placeholder={driving ? "Or type it here" : "What needs doing?"}
        className={driving ? `is-driving is-${driveStage}` : ""}
        panel={driving ? <Drive api={api} feed={feed} commandRef={driveCommand} toolbar={driveToolbar} pickerSlot={drivePicker} /> : undefined}
      >
        {driving ? (
          <span ref={setDrivePicker} className="composer-picker-slot" />
        ) : (
          <select
            value={vertical}
            onChange={(e) => {
              setVertical(e.target.value);
              setThreadId(null);
              setQueue([]);
            }}
            aria-label="Send to"
            data-help-key="chat.send-to"
          >
            <option value="">Chief of Staff</option>
            {verticals.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <div className="composer-tools" role="group" aria-label="Chat options">
          {threadId && (
            <button type="button" className="tool" onClick={newChat} title="Start a new chat">
              <Icon name="plus" size={16} />
              <span>New chat</span>
            </button>
          )}
          <ReadAloudToggle readAloud={readAloud} />
          <a
            className={`tool ${drive ? "is-on" : ""}`}
            href={drive ? "#/chat" : "#/converse"}
            aria-label={drive ? "Fold Converse away, back to typing" : "Converse: talk it through hands-free"}
            title={drive ? "Fold Converse away, back to typing" : "Converse: talk it through hands-free"}
          >
            <Icon name={drive ? "fold" : "drive"} size={16} />
            <span>{drive ? "Fold" : "Converse"}</span>
          </a>
          {driving && <span ref={setDriveToolbar} className="composer-tools-slot" />}
        </div>
      </Composer>
    </section>
  );
}

/** Approvals in the chat thread: the pending ones in full, the decided ones folded away. */
function InlineProposals({ api, proposals }: { api: Api; proposals: Proposal[] }) {
  if (!proposals.length) return null;
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");
  return (
    <div className="inline-proposals">
      {pending.length > 0 && (
        <p className="small muted">
          {pending.length === 1 ? "Waiting for your approval:" : `${pending.length} waiting for your approval:`}
        </p>
      )}
      {pending.map((p) => (
        <ProposalCard key={p.id} api={api} proposal={p} />
      ))}
      {decided.length > 0 && (
        <details>
          <summary className="small muted">
            {decided.length} action{decided.length === 1 ? "" : "s"} done or decided
          </summary>
          {decided.map((p) => (
            <ProposalCard key={p.id} api={api} proposal={p} />
          ))}
        </details>
      )}
    </div>
  );
}
