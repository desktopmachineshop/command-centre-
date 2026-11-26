import { ScriptedRunner } from "@cc/agent-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { answerPreview, isRoutine, outcomeNotification, taskTag } from "../src/outcome";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

describe("answerPreview", () => {
  it("keeps the words and drops cards, code, the voice line and markdown marks", () => {
    const answer = "## Stock\n\nWe have **12** of the `SP-300W` on hand, see [Odoo](https://x.odoo.com).\n\n```card\nodoo.product:2\n```\n\n- Forecast: 10\n- *Low*: the collets\n\n{\"voice\":{\"type\":\"final\",\"text\":\"Twelve.\"}}";
    expect(answerPreview(answer)).toBe("Stock\nWe have 12 of the SP-300W on hand, see Odoo.\n• Forecast: 10\n• Low: the collets");
    expect(answerPreview(null)).toBe("");
    expect(answerPreview("```card\nodoo.product:2\n```")).toBe("");
  });

  it("cuts a long answer at a word", () => {
    const out = answerPreview("word ".repeat(200), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("word…")).toBe(true);
  });
});

describe("outcomeNotification", () => {
  it("gives the answer's first lines, opening the task and replacing its progress updates", () => {
    expect(outcomeNotification({ taskId: "t-1", vertical: "dms", ask: "how many spindles?\nand collets", status: "done", result: "We have **12**." })).toEqual({
      title: "how many spindles?",
      body: "We have 12.",
      url: "/task/t-1",
      category: "agent",
      priority: "normal",
      vertical: "dms",
      tag: taskTag("t-1"),
      replaces: true,
      renotify: true,
      data: { taskId: "t-1", outcome: "done" },
    });
    expect(outcomeNotification({ taskId: "t-1", vertical: "dms", ask: "x", status: "done", result: "" })).toBeNull();
  });

  it("isn't held for quiet hours when he asked minutes ago", () => {
    const now = new Date("2026-11-16T23:00:00Z");
    const o = { taskId: "t-1", vertical: "dms", ask: "x", status: "done" as const, result: "ok", now };
    expect(outcomeNotification({ ...o, askedAt: new Date("2026-11-16T22:58:00Z") })).toMatchObject({ breaksQuiet: true });
    expect(outcomeNotification({ ...o, askedAt: new Date("2026-11-16T22:30:00Z") })).not.toHaveProperty("breaksQuiet");
    expect(outcomeNotification(o)).not.toHaveProperty("breaksQuiet");
  });

  it("says why something didn't finish", () => {
    const n = outcomeNotification({ taskId: "t-1", vertical: "dms", ask: "post the reel", status: "failed", note: "Run failed: Claude usage limit reached; resets at 03:00" })!;
    expect(n).toMatchObject({ title: "Didn't finish: post the reel", body: "Claude usage limit reached; resets at 03:00", priority: "high", category: "agent" });
    expect(outcomeNotification({ taskId: "t-1", vertical: "dms", ask: "x", status: "failed", note: null })!.body).toMatch(/without saying why/);
  });
});

describe("isRoutine", () => {
  const done = { actionType: "pa.items.add", status: "executed" };
  it("is a small thing done and merely confirmed", () => {
    expect(isRoutine({ tools: ["ToolSearch", "mcp__pa__add_reminder"], proposals: [], result: "I've set a reminder for tomorrow at 10:00." })).toBe(true);
    expect(isRoutine({ tools: ["mcp__actions__propose_action"], proposals: [done], result: "Added milk to **Shopping**." })).toBe(true);
    expect(isRoutine({ tools: [], proposals: [{ actionType: "brain.journal", status: "executed" }], result: "Logged." })).toBe(true);
  });

  it("isn't when it tells or asks Dave something, or anything is left to decide", () => {
    // A lookup is an answer, however short.
    expect(isRoutine({ tools: ["mcp__odoo__search_products"], proposals: [], result: "We have 12." })).toBe(false);
    expect(isRoutine({ tools: ["mcp__pa__list_reminders"], proposals: [], result: "Nothing due." })).toBe(false);
    // It asks him something.
    expect(isRoutine({ tools: ["mcp__pa__add_reminder"], proposals: [], result: "Set. Do you want the accountant's number on it?" })).toBe(false);
    // It has more to say than a confirmation.
    expect(isRoutine({ tools: ["mcp__pa__add_reminder"], proposals: [], result: "x ".repeat(300) })).toBe(false);
    // Something waits for approval, failed, or reaches outside.
    expect(isRoutine({ tools: [], proposals: [done, { actionType: "pa.reminder.add", status: "pending" }], result: "Done." })).toBe(false);
    expect(isRoutine({ tools: [], proposals: [{ actionType: "pa.items.add", status: "failed" }], result: "Done." })).toBe(false);
    expect(isRoutine({ tools: ["mcp__pa__add_reminder"], proposals: [{ actionType: "email.send", status: "executed" }], result: "Done." })).toBe(false);
  });
});

describe("who is watching", () => {
  it("counts a client whose app is on screen and still answering pings", () => {
    vi.useFakeTimers();
    try {
      const hub = new Hub();
      expect(hub.watching()).toBe(false);
      const phone = { send: () => {} };
      hub.addClient(phone);
      expect(hub.watching()).toBe(true);
      hub.setVisible(phone, false);
      expect(hub.watching()).toBe(false);
      hub.setVisible(phone, true);
      vi.advanceTimersByTime(60_000);
      expect(hub.watching()).toBe(true);
      // Frozen in the background, or the connection lost without a close: it stops counting.
      vi.advanceTimersByTime(20_000);
      expect(hub.watching()).toBe(false);
      hub.setVisible(phone, true);
      hub.removeClient(phone);
      expect(hub.watching()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!DB_URL)("telling Dave how his request ended", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new ScriptedRunner("echo", (req) =>
    /fail/.test(req.prompt)
      ? { result: { status: "failed", result: null, error: "Timed out after 15 minutes", costUsd: 0, sessionId: null } }
      : /shopping list/.test(req.prompt)
        ? { messages: [{ type: "tool_use", name: "mcp__pa__add_items", input: {} }], result: { status: "succeeded", result: "Added milk to Shopping.", error: null, costUsd: 0, sessionId: null } }
        : { result: { status: "succeeded", result: "We have **12** in stock.\n\n```card\nodoo.product:2\n```", error: null, costUsd: 0, sessionId: null } },
  );
  const chat = async (text: string) => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text } });
    await ctx.queue.drain();
    return body.task.id as string;
  };
  const centre = async () => (await ctx.api("/api/notifications")).body.items as { title: string; body: string; url: string; tag: string; data: Record<string, unknown> }[];

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
  });
  afterAll(async () => {
    await ctx?.server.stop();
  });
  beforeEach(() => {
    ctx.notifier.sent.length = 0;
  });

  it("notifies with the answer when the app isn't on screen, and replaces the task's progress updates", async () => {
    const id = await chat("how many spindles do we have?");
    expect(ctx.notifier.sent).toEqual([expect.objectContaining({ title: "how many spindles do we have?", body: "We have 12 in stock.", url: `/task/${id}`, category: "agent" })]);

    // A progress update for the same task, then the answer to a follow-up: one row for the task.
    await ctx.server.notifications.notify({ title: "how many spindles do we have? (2 min)", body: "Working: odoo search_products", category: "agent", tag: taskTag(id), replaces: true, url: `/task/${id}` });
    expect((await centre()).filter((n) => n.tag === taskTag(id)).map((n) => n.body)).toEqual(["Working: odoo search_products"]);
    await ctx.api(`/api/tasks/${id}/reply`, { method: "POST", json: { text: "and the collets?" } });
    await ctx.queue.drain();
    const rows = (await centre()).filter((n) => n.tag === taskTag(id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "We have 12 in stock.", data: { taskId: id, outcome: "done" } });
  });

  it("reads what was said about a task once it is opened", async () => {
    const id = await chat("how many collets?");
    const before = (await ctx.api("/api/notifications/unread-count")).body.unread;
    const { body } = await ctx.api(`/api/notifications/read-task/${id}`, { method: "POST" });
    expect(body).toEqual({ changed: 1, unread: before - 1 });
    expect((await ctx.api(`/api/notifications/read-task/${id}`, { method: "POST" })).body.changed).toBe(0);
  });

  it("lists each task with how it came out", async () => {
    const tasks = (await ctx.api("/api/tasks")).body as { prompt: string; outcome: string | null }[];
    expect(tasks.find((t) => t.prompt === "how many collets?")?.outcome).toBe("We have 12 in stock.");
  });

  it("says why a request failed", async () => {
    await chat("this will fail");
    expect(ctx.notifier.sent).toEqual([expect.objectContaining({ title: "Didn't finish: this will fail", body: "Timed out after 15 minutes", priority: "high" })]);
  });

  it("stays quiet while the app is on screen, and for work Dave didn't ask for", async () => {
    const screen = { send: () => {} };
    ctx.server.hub.addClient(screen);
    await chat("how many spindles do we have now?");
    expect(ctx.notifier.sent).toEqual([]);
    ctx.server.hub.removeClient(screen);

    await ctx.server.pipeline.ingest({ source: "webhook", vertical: "dms", kind: "ping", title: "A webhook", payload: { text: "hello" } });
    await ctx.queue.drain();
    expect(ctx.notifier.sent.filter((n) => n.title === "A webhook")).toEqual([]);
  });

  it("says nothing about a chat task the app filed for itself (a lesson's pronunciation pass), ended or failed", async () => {
    await ctx.server.pipeline.ingest({ source: "chat", vertical: "personal", kind: "message", title: "Lesson pronunciation: Cortisol", payload: { text: "fix the respellings", quiet: true } });
    await ctx.server.pipeline.ingest({ source: "chat", vertical: "personal", kind: "message", title: "Lesson check: Cortisol", payload: { text: "this will fail", quiet: true } });
    await ctx.queue.drain();
    expect(ctx.notifier.sent).toEqual([]);
  });

  it("says nothing for a routine confirmation: the item on the list is the confirmation", async () => {
    const before = (await centre()).length;
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "add milk to the shopping list" } });
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.task.status).toBe("done");
    expect(ctx.notifier.sent).toEqual([]);
    expect(await centre()).toHaveLength(before);
  });

  it("leaves mail that was only sorted out of the activity feed", async () => {
    const store = ctx.server.store;
    const { rows } = await store.pool.query("select id, event_id from tasks order by created_at desc limit 1");
    // Make the newest task look like a filed newsletter.
    await store.pool.query("update events set source = 'email' where id = $1", [rows[0].event_id]);
    await store.pool.query("update tasks set route = 'file' where id = $1", [rows[0].id]);
    const all = (await ctx.api("/api/tasks")).body as { id: string; source: string }[];
    const feed = (await ctx.api("/api/tasks?feed=1")).body as { id: string; source: string }[];
    expect(all.find((t) => t.id === rows[0].id)?.source).toBe("email");
    expect(feed.some((t) => t.id === rows[0].id)).toBe(false);
    expect(feed.length).toBe(all.length - 1);
    expect(feed.every((t) => t.source === "chat" || t.source === "webhook")).toBe(true);
  });

  it("tells Dave when an action fails, and runs it again when he says so", async () => {
    const id = await chat("something with an action");
    ctx.notifier.sent.length = 0;
    // A brain write to a path the brain refuses: the action fails when it runs.
    const failed = await ctx.server.actions.propose({ taskId: id, vertical: "personal", actionType: "brain.write", summary: "Save the note", payload: { path: "../outside.md", body: "x" } });
    expect(failed.status).toBe("failed");
    expect(ctx.notifier.sent).toEqual([expect.objectContaining({ title: "Didn't go through: Save the note", category: "alert", priority: "high", url: `/task/${id}` })]);
    const alert = (await centre()).find((n) => n.title === "Didn't go through: Save the note")!;
    expect(alert.data).toMatchObject({ failedProposalId: failed.id, taskId: id });
    expect(alert.body).toMatch(/Open it to try again\.$/);

    // Try again: it runs once more (and fails the same way here), without a second row for it.
    const again = (await ctx.api(`/api/proposals/${failed.id}/retry`, { method: "POST" })).body;
    expect(again.status).toBe("failed");
    expect((await centre()).filter((n) => n.title === "Didn't go through: Save the note")).toHaveLength(1);
    // Only a failed action can be retried.
    const fine = await ctx.server.actions.propose({ taskId: id, vertical: "personal", actionType: "brain.journal", summary: "Log it", payload: { text: "x" } });
    expect((await ctx.api(`/api/proposals/${fine.id}/retry`, { method: "POST" })).status).toBe(409);
  });

  it("links an agent's own notification back to its task", async () => {
    const id = await chat("something quiet");
    const p = await ctx.server.actions.propose({ taskId: id, vertical: "personal", actionType: "notify", summary: "Tell Dave", payload: { title: "Order S00042 looks stuck", body: "The spindle hasn't shipped." } });
    expect(p.status).toBe("executed");
    expect((await centre()).find((n) => n.title === "Order S00042 looks stuck")?.data).toMatchObject({ taskId: id });
  });
});
