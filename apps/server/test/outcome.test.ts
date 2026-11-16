import { ScriptedRunner } from "@cc/agent-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { answerPreview, outcomeNotification, taskTag } from "../src/outcome";
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

  it("links an agent's own notification back to its task", async () => {
    const id = await chat("something quiet");
    const p = await ctx.server.actions.propose({ taskId: id, vertical: "personal", actionType: "notify", summary: "Tell Dave", payload: { title: "Order S00042 looks stuck", body: "The spindle hasn't shipped." } });
    expect(p.status).toBe("executed");
    expect((await centre()).find((n) => n.title === "Order S00042 looks stuck")?.data).toMatchObject({ taskId: id });
  });
});
