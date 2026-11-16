import type { AgentMessage, Proposal } from "@cc/core";
import { describe, expect, it } from "vitest";
import { decidedSummary } from "../src/pages/Approvals";
import { cardKindsIn, statusWords, threadOf } from "../src/pages/TaskView";
import { htmlToText, readable } from "../src/payload";
import { actionLabel } from "../src/format";

const run = (id: string, startedAt: string, messages: AgentMessage[] = []) => ({ id, taskId: "t", runner: "claude-code", status: "succeeded" as const, result: null, error: null, costUsd: 0.1, sessionId: null, startedAt, finishedAt: null, messages });
const proposal = (id: string, createdAt: string, status = "pending") => ({ id, createdAt, status }) as Proposal;

describe("a task as a conversation", () => {
  it("puts each run in order with what opened it and the actions it proposed", () => {
    const thread = threadOf(
      [
        run("r2", "2026-11-16T10:05:00Z", [{ type: "system", text: "Dave replied: make it Friday" }]),
        run("r1", "2026-11-16T10:00:00Z"),
        run("r3", "2026-11-16T11:00:00Z", [{ type: "system", text: "the Software Lead (Command Centre) reported back: merged" }]),
      ],
      [proposal("early", "2026-11-16T09:59:59Z"), proposal("first", "2026-11-16T10:01:00Z"), proposal("second", "2026-11-16T10:06:00Z"), proposal("late", "2026-11-16T12:00:00Z")],
    );
    expect(thread.map((s) => s.run.id)).toEqual(["r1", "r2", "r3"]);
    expect(thread.map((s) => s.opener?.from ?? null)).toEqual([null, "dave", "role"]);
    expect(thread.map((s) => s.proposals.map((p) => p.id))).toEqual([["early", "first"], ["second"], ["late"]]);
    expect(threadOf([], [proposal("p", "2026-11-16T10:00:00Z")])).toEqual([]);
  });

  it("says how it stands in plain words", () => {
    expect(statusWords({ status: "awaiting_approval", note: null })).toBe("Waiting for your approval");
    expect(statusWords({ status: "failed", note: "Run failed: x" })).toBe("Didn't finish");
    expect(statusWords({ status: "failed", note: "Stopped from the app." })).toBe("Stopped");
    expect(statusWords({ status: "deferred", note: null })).toBe("Held by the daily budget");
  });

  it("knows which kinds of record the answer already shows", () => {
    const messages: AgentMessage[] = [{ type: "text", text: "Here:\n\n```card\nodoo.order:S00042\nodoo.customer:10\n```\n\nand `odoo.product:1` in passing" }, { type: "tool_use", name: "x", input: "```card\nodoo.product:2\n```" }];
    expect(cardKindsIn(messages)).toEqual(["odoo.order", "odoo.customer"]);
  });

  it("sums up decided actions", () => {
    const of = (...statuses: string[]) => decidedSummary(statuses.map((status) => ({ status }) as Proposal));
    expect(of("executed")).toBe("1 action done");
    expect(of("executed", "executed", "failed", "rejected")).toBe("2 actions done, 1 failed, 1 rejected");
    expect(of("rejected")).toBe("1 rejected");
    expect(of("approved")).toBe("1 action decided");
  });
});

describe("reading what an action will send", () => {
  it("shows markup as the words its reader gets", () => {
    expect(htmlToText("<p>Hi Jane,</p><p>Sorry &amp; thanks.<br>It ships <strong>tomorrow</strong> for &pound;5.</p><ul><li>One</li><li>Two</li></ul><p><a href=\"https://x.test/t\">Track it</a></p>")).toBe(
      "Hi Jane,\n\nSorry & thanks.\nIt ships tomorrow for £5.\n\n• One\n• Two\n\nTrack it (https://x.test/t)",
    );
    expect(readable("<p>Hi</p><p>Dave</p>")).toEqual({ kind: "text", text: "Hi\n\nDave" });
    // Plain text with an angle bracket is left alone.
    expect(readable("qty < 3 and price > 2")).toEqual({ kind: "text", text: "qty < 3 and price > 2" });
  });
});

describe("action names for reading", () => {
  it("says the area and the action in words", () => {
    expect(actionLabel("odoo.product.update_price")).toBe("Odoo: product, update price");
    expect(actionLabel("email.reply")).toBe("Email: reply");
    expect(actionLabel("notify")).toBe("Notification");
    expect(actionLabel("pa.items.add")).toBe("Personal: items, add");
    expect(actionLabel("newthing.do_it")).toBe("Newthing: do it");
  });
});
