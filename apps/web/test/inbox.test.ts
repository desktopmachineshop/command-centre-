import type { Proposal, StoredNotification, Task } from "@cc/core";
import { describe, expect, it } from "vitest";
import { sourceLabel } from "../src/pages/Activity";
import { approvalGroups, waitingCount, waitingOf } from "../src/pages/Inbox";

const NOW = Date.parse("2026-11-16T22:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  eventId: `e-${id}`,
  vertical: "dms",
  intent: "request",
  route: "agent",
  urgency: 0.5,
  status: "failed",
  prompt: "do the thing",
  note: "Run failed: timed out",
  source: "chat",
  createdAt: "2026-11-16T21:00:00Z",
  updatedAt: "2026-11-16T21:30:00Z",
  ...over,
});
const note = (id: string, over: Partial<StoredNotification> = {}): StoredNotification =>
  ({ id, category: "agent", priority: "normal", vertical: "dms", title: id, body: "", url: null, tag: null, actions: [], media: [], data: {}, status: "sent", createdAt: "2026-11-16T21:00:00Z", pushedAt: null, readAt: null, ...over }) as StoredNotification;
const approval = { id: "p1", status: "pending" } as Proposal;

describe("what goes in the Inbox", () => {
  it("keeps approvals, what Dave asked for that failed, and messages that matter", () => {
    const w = waitingOf({
      now: NOW,
      approvals: [approval],
      failedTasks: [task("asked"), task("from-email", { source: "email" }), task("stopped", { note: "Stopped from the app." }), task("old", { updatedAt: "2026-11-10T09:00:00Z" }), task("dismissed")],
      dismissed: ["dismissed"],
      unread: [
        note("answer", { data: { taskId: "t9", outcome: "done" }, tag: "progress-t9" }),
        note("reminder", { category: "reminder" }),
        note("rfq", { category: "quotes" }),
        note("alert", { category: "alert" }),
        // Not cards: the approval is already there, progress isn't news, the rest is automated work.
        note("approve", { category: "approval" }),
        note("progress", { tag: "progress-t1" }),
        note("digest", { category: "digest" }),
        note("order", { category: "orders" }),
        note("comment", { category: "social" }),
        note("system", { category: "system" }),
        // What was said about a failed task already listed (even a dismissed one).
        note("failed-push", { data: { taskId: "asked", outcome: "failed" } }),
        note("dismissed-push", { data: { taskId: "dismissed", outcome: "failed" } }),
      ],
    });
    expect(w.approvals).toEqual([approval]);
    expect(w.failed.map((t) => t.id)).toEqual(["asked"]);
    expect(w.messages.map((n) => n.id)).toEqual(["answer", "reminder", "rfq", "alert"]);
    expect(waitingCount(w)).toBe(6);
  });

  it("keeps one task's approvals together", () => {
    const p = (id: string, taskId: string | null) => ({ id, taskId }) as Proposal;
    expect(approvalGroups([p("a", "t1"), p("b", "t2"), p("c", "t1"), p("d", null), p("e", null)]).map((g) => g.proposals.map((x) => x.id))).toEqual([["a", "c"], ["b"], ["d"], ["e"]]);
  });

  it("is empty when nothing needs him", () => {
    expect(waitingCount(waitingOf({ approvals: [], failedTasks: [], unread: [note("digest", { category: "digest" })], now: NOW }))).toBe(0);
  });
});

describe("Activity", () => {
  it("says where a task came from in words", () => {
    expect(sourceLabel("chat")).toBe("You asked");
    expect(sourceLabel("cron")).toBe("Scheduled");
    expect(sourceLabel("email")).toBe("Email");
    expect(sourceLabel("something")).toBe("something");
    expect(sourceLabel(null)).toBe("Task");
  });
});
