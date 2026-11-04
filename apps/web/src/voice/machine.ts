/**
 * Drive mode's state machine, as a pure reducer (the Drive page runs the side
 * effects: microphone, speech, network). The loop is
 *
 *   idle → listening → sending → waiting → speaking → (converse ? listening : idle)
 *
 * In push-to-talk mode it never listens on its own: after speaking it goes back
 * to idle and the next button press answers whatever was asked. In
 * conversational mode it listens again whenever an answer is expected (a
 * `converse` reply, an approval being read out, a confirmation), asks "Still
 * there?" once after a silence, then gives up.
 */
import type { VoiceMode } from "./commands";

export type Phase = "idle" | "listening" | "sending" | "waiting" | "speaking";

/**
 * What the next utterance answers:
 * - none: nothing (a fresh command);
 * - command: a follow-up after a final answer (hands-free follow-up only);
 * - reply: the agent asked a question (`converse`) on `conversation.taskId`;
 * - approval: an approval was read out, waiting for approve / reject / next;
 * - confirm: an approve or reject waiting for "yes, approve" / "yes, reject".
 */
export type Expect = "none" | "command" | "reply" | "approval" | "confirm";

export interface Approval {
  proposalId: string;
  summary: string;
}

export interface DriveState {
  mode: VoiceMode;
  /** After a final answer in conversational mode, listen a few seconds for a follow-up. */
  followUp: boolean;
  phase: Phase;
  /** Bumped whenever speaking or listening (re)starts, so effects re-run for the same phase. */
  seq: number;
  expect: Expect;
  /** What is being spoken now. */
  utterance: string | null;
  /** The speech is a reply still being streamed (Drive's reply stream supplies the words). */
  streamed: boolean;
  /** The last thing spoken, for "repeat". */
  lastSpoken: string | null;
  /** Task whose agent asked a question and waits for Dave's reply. */
  conversation: { taskId: string } | null;
  /** Task the app is waiting on. */
  waitingFor: string | null;
  /** The approval read out last. */
  approval: Approval | null;
  /** Approval awaiting confirmation. */
  confirm: (Approval & { action: "approve" | "reject" }) | null;
  /** Approvals skipped with "next" in this round. */
  skipped: string[];
  stillThereAsked: boolean;
  /** Something to say once the current listen/send finishes (e.g. an answer that arrived meanwhile). */
  pending: Say | null;
  error: string | null;
}

export interface Say {
  text: string;
  expect: Expect;
  /** For expect "reply". */
  taskId?: string;
  approval?: Approval;
  confirm?: Approval & { action: "approve" | "reject" };
  /** The words come from a streamed reply rather than `text`. */
  streamed?: boolean;
}

export type DriveAction =
  | { type: "mode"; mode: VoiceMode }
  | { type: "followUp"; on: boolean }
  /**
   * The main button (screen) or a headset / steering-wheel button. While speaking only the
   * screen button interrupts: the phone itself fires media "pause" when it starts talking.
   */
  | { type: "press"; source?: "screen" | "headset" }
  | { type: "heard"; text: string }
  /** Listening ended with nothing heard. */
  | { type: "silence" }
  /** A chat request or reply was accepted; now waiting for the agent. */
  | { type: "waiting"; taskId: string }
  /** `background`: an agent answer arriving on its own, rather than the reply to what Dave just said. */
  | ({ type: "say"; background?: boolean } & Say)
  /** Speech finished. `text`: what a streamed reply said in the end (for "repeat"). */
  | { type: "spoken"; text?: string }
  | { type: "skip"; proposalId: string }
  | { type: "resetSkips" }
  /** "stop", "cancel", "that's all": end everything. */
  | { type: "end" }
  | { type: "error"; message: string };

export const STILL_THERE = "Still there?";

export function initialDriveState(mode: VoiceMode = "push", followUp = false): DriveState {
  return {
    mode,
    followUp,
    phase: "idle",
    seq: 0,
    expect: "none",
    utterance: null,
    streamed: false,
    lastSpoken: null,
    conversation: null,
    waitingFor: null,
    approval: null,
    confirm: null,
    skipped: [],
    stillThereAsked: false,
    pending: null,
    error: null,
  };
}

/** Speak `say`, setting the context it opens. */
function speak(state: DriveState, say: Say): DriveState {
  return {
    ...state,
    phase: "speaking",
    seq: state.seq + 1,
    utterance: say.text,
    streamed: say.streamed ?? false,
    lastSpoken: say.streamed ? state.lastSpoken : say.text,
    expect: say.expect,
    conversation: say.expect === "reply" && say.taskId ? { taskId: say.taskId } : say.expect === "reply" ? state.conversation : null,
    approval: say.approval ?? (say.expect === "approval" || say.expect === "confirm" ? state.approval : null),
    confirm: say.expect === "confirm" ? (say.confirm ?? state.confirm) : null,
    waitingFor: null,
    pending: null,
    error: null,
  };
}

/** Back to idle; delivers a pending answer first. */
function settle(state: DriveState): DriveState {
  if (state.pending) return speak(state, state.pending);
  return { ...state, phase: "idle", utterance: null, streamed: false };
}

export function driveReducer(state: DriveState, action: DriveAction): DriveState {
  switch (action.type) {
    case "mode":
      return { ...state, mode: action.mode };
    case "followUp":
      return { ...state, followUp: action.on };

    case "press":
      switch (state.phase) {
        case "speaking": // Interrupt (screen only)
          if (action.source === "headset") return state;
          return { ...state, phase: "listening", seq: state.seq + 1, utterance: null, streamed: false, stillThereAsked: false, error: null };
        case "idle":
        case "waiting": // speak over a long run (e.g. "cancel")
          return { ...state, phase: "listening", seq: state.seq + 1, utterance: null, streamed: false, stillThereAsked: false, error: null };
        case "listening":
          return settle({ ...state, phase: "idle" });
        default:
          return state;
      }

    case "heard":
      if (state.phase !== "listening") return state;
      return { ...state, phase: "sending", stillThereAsked: false };

    case "silence": {
      if (state.phase !== "listening") return state;
      const answering = state.expect === "reply" || state.expect === "approval" || state.expect === "confirm";
      if (state.mode === "conversational" && answering && !state.stillThereAsked) {
        return { ...speak(state, { text: STILL_THERE, expect: state.expect }), stillThereAsked: true, lastSpoken: state.lastSpoken };
      }
      if (state.mode === "conversational" || state.stillThereAsked) {
        // Nobody answered: let the conversation go.
        return settle({ ...state, phase: "idle", expect: "none", conversation: null, confirm: null, stillThereAsked: false });
      }
      // Push-to-talk: a press with nothing said keeps the question open.
      return settle({ ...state, phase: "idle" });
    }

    case "waiting":
      // Never cut off speech or Dave: the answer is still followed, and spoken when it comes.
      if (state.phase === "speaking" || state.phase === "listening") return { ...state, waitingFor: action.taskId };
      return { ...state, phase: "waiting", waitingFor: action.taskId, expect: "none", confirm: null };

    case "say": {
      const { type: _type, background, ...say } = action;
      // Don't talk over Dave, never cut off what is being said (it is read in full), and let an
      // agent answer that arrives while a request is being sent wait its turn.
      const busy = state.phase === "listening" || state.phase === "speaking" || (background && state.phase === "sending");
      if (busy) return { ...state, pending: say };
      return speak(state, say);
    }

    case "spoken": {
      if (state.phase !== "speaking") return state;
      if (action.text) state = { ...state, lastSpoken: action.text };
      if (state.pending) return speak(state, state.pending);
      const listen = state.mode === "conversational" && state.expect !== "none" && (state.expect !== "command" || state.followUp);
      if (listen) return { ...state, phase: "listening", seq: state.seq + 1, utterance: null, streamed: false };
      return settle({ ...state, phase: "idle", expect: state.expect === "command" ? "none" : state.expect });
    }

    case "skip":
      return { ...state, skipped: [...state.skipped, action.proposalId] };
    case "resetSkips":
      return { ...state, skipped: [] };

    case "end":
      return {
        ...initialDriveState(state.mode, state.followUp),
        seq: state.seq,
        lastSpoken: state.lastSpoken,
        skipped: state.skipped,
      };

    case "error":
      return { ...state, phase: "idle", utterance: null, streamed: false, waitingFor: null, error: action.message };
  }
}

/** How long a pause ends Dave's turn with browser recognition (he can also tap Send); live transcription ends it sooner, on the server. */
export const END_OF_TURN_MS = 2500;

/** Push to talk is latched: a turn lasts until Send, for up to this long (a long message, with pauses to think). */
export const LATCHED_TURN_MS = 5 * 60_000;

export function listenTimeoutMs(state: DriveState): number {
  if (state.mode === "push") return LATCHED_TURN_MS;
  return state.expect === "command" ? 5_000 : 8_000;
}
