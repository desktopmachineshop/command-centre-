import { describe, expect, it } from "vitest";
import { type DriveAction, type DriveState, driveReducer, initialDriveState, listenTimeoutMs, STILL_THERE } from "../src/voice/machine";

const run = (state: DriveState, ...actions: DriveAction[]) => actions.reduce(driveReducer, state);
const phases = (state: DriveState, actions: DriveAction[]) => {
  const out: string[] = [];
  actions.reduce((s, a) => {
    const next = driveReducer(s, a);
    out.push(next.phase);
    return next;
  }, state);
  return out;
};

const converse: DriveAction = { type: "say", text: "Which supplier?", expect: "reply", taskId: "t1", background: true };
const final: DriveAction = { type: "say", text: "Done.", expect: "none", taskId: "t1", background: true };

describe("drive state machine", () => {
  it("conversational: idle → listening → sending → waiting → speaking → listening on converse", () => {
    const s = initialDriveState("conversational");
    expect(phases(s, [{ type: "press" }, { type: "heard", text: "order collets" }, { type: "waiting", taskId: "t1" }, converse, { type: "spoken" }])).toEqual([
      "listening",
      "sending",
      "waiting",
      "speaking",
      "listening",
    ]);
    const after = run(s, { type: "press" }, { type: "heard", text: "x" }, { type: "waiting", taskId: "t1" }, converse, { type: "spoken" });
    expect(after.conversation).toEqual({ taskId: "t1" });
    expect(after.expect).toBe("reply");
  });

  it("conversational: a final answer goes back to idle", () => {
    const s = run(initialDriveState("conversational"), { type: "press" }, { type: "heard", text: "x" }, { type: "waiting", taskId: "t1" }, final, { type: "spoken" });
    expect(s.phase).toBe("idle");
    expect(s.conversation).toBeNull();
  });

  it("push-to-talk: a converse answer is spoken, then waits for the button with the conversation open", () => {
    const s = run(initialDriveState("push"), { type: "press" }, { type: "heard", text: "x" }, { type: "waiting", taskId: "t1" }, converse, { type: "spoken" });
    expect(s.phase).toBe("idle");
    expect(s.expect).toBe("reply");
    expect(s.conversation).toEqual({ taskId: "t1" });
    const pressed = run(s, { type: "press" });
    expect(pressed.phase).toBe("listening");
    expect(pressed.conversation).toEqual({ taskId: "t1" });
  });

  it("asks 'Still there?' once after silence, then gives up", () => {
    const listening = run(initialDriveState("conversational"), { type: "press" }, { type: "heard", text: "x" }, { type: "waiting", taskId: "t1" }, converse, { type: "spoken" });
    const asked = run(listening, { type: "silence" });
    expect(asked.phase).toBe("speaking");
    expect(asked.utterance).toBe(STILL_THERE);
    expect(asked.lastSpoken).toBe("Which supplier?"); // "repeat" still repeats the question
    const again = run(asked, { type: "spoken" });
    expect(again.phase).toBe("listening");
    const gone = run(again, { type: "silence" });
    expect(gone.phase).toBe("idle");
    expect(gone.conversation).toBeNull();
    expect(gone.expect).toBe("none");
  });

  it("push-to-talk silence keeps the question open and never asks 'Still there?'", () => {
    const s = run(initialDriveState("push"), converse, { type: "spoken" }, { type: "press" }, { type: "silence" });
    expect(s.phase).toBe("idle");
    expect(s.expect).toBe("reply");
  });

  it("end (stop / cancel / that's all) ends the conversation from any phase", () => {
    for (const phase of ["listening", "waiting", "speaking"] as const) {
      const base = run(initialDriveState("conversational"), converse, { type: "spoken" });
      const s = { ...base, phase };
      const ended = run(s, { type: "end" });
      expect(ended).toMatchObject({ phase: "idle", conversation: null, expect: "none", confirm: null, mode: "conversational" });
    }
  });

  it("toggles mode and follow-up", () => {
    let s = run(initialDriveState("push"), { type: "mode", mode: "conversational" });
    expect(s.mode).toBe("conversational");
    // Final answers only auto-listen with hands-free follow-up on.
    s = run(s, { type: "followUp", on: true }, { type: "say", text: "Done.", expect: "command" }, { type: "spoken" });
    expect(s.phase).toBe("listening");
    expect(listenTimeoutMs(s)).toBe(5000);
    s = run(s, { type: "silence" });
    expect(s.phase).toBe("idle");
  });

  it("holds an answer that arrives while Dave is talking, then speaks it", () => {
    const s = run(initialDriveState("push"), { type: "press" }, final);
    expect(s.phase).toBe("listening");
    expect(s.pending?.text).toBe("Done.");
    const later = run(s, { type: "silence" });
    expect(later.phase).toBe("speaking");
    expect(later.utterance).toBe("Done.");
  });

  it("an approval readback waits for confirmation", () => {
    const approval = { proposalId: "p1", summary: "Reply to Jane" };
    let s = run(initialDriveState("conversational"), { type: "say", text: "Approval 1 of 1", expect: "approval", approval });
    s = run(s, { type: "spoken" });
    expect(s).toMatchObject({ phase: "listening", expect: "approval", approval });
    s = run(s, { type: "heard", text: "approve" }, { type: "say", text: "To approve: Reply to Jane…", expect: "confirm", confirm: { ...approval, action: "approve" } });
    expect(s).toMatchObject({ phase: "speaking", expect: "confirm", confirm: { proposalId: "p1", action: "approve" }, approval });
    s = run(s, { type: "spoken" });
    expect(s.phase).toBe("listening");
  });

  it("press barges in on speech; seq changes so effects restart", () => {
    const speaking = run(initialDriveState("push"), final);
    const barged = run(speaking, { type: "press" });
    expect(barged.phase).toBe("listening");
    expect(barged.seq).toBeGreaterThan(speaking.seq);
  });

  it("reads an answer in full: a headset press or another message doesn't cut it off", () => {
    const speaking = run(initialDriveState("conversational"), converse);
    expect(run(speaking, { type: "press", source: "headset" })).toBe(speaking);
    const queued = run(speaking, { type: "say", text: "I couldn't load the approvals.", expect: "none" });
    expect(queued).toMatchObject({ phase: "speaking", utterance: "Which supplier?", pending: { text: "I couldn't load the approvals." } });
    // The queued message is spoken once the answer has finished.
    const after = run(queued, { type: "spoken" });
    expect(after).toMatchObject({ phase: "speaking", utterance: "I couldn't load the approvals." });
  });

  it("the screen button interrupts speech; while listening a press sends", () => {
    const speaking = run(initialDriveState("conversational"), converse);
    const interrupted = run(speaking, { type: "press", source: "screen" });
    expect(interrupted.phase).toBe("listening");
    expect(run(interrupted, { type: "press", source: "headset" }).phase).toBe("idle");
  });

  it("conversation mode only listens once speech has finished", () => {
    const s = run(initialDriveState("conversational"), converse);
    expect(s.phase).toBe("speaking");
    expect(run(s, { type: "spoken" }).phase).toBe("listening");
  });
});
