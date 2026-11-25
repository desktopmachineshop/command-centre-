import type { AgentRunner, AgentRunRequest } from "@cc/agent-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERRUPTED_ERROR, INTERRUPTED_NOTE, LIMIT_NOTE, LIMIT_RETRIES } from "../src/pipeline";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

/** Runs until it is aborted (as a real agent would be when the server stops), unless told to answer. */
class HangingRunner implements AgentRunner {
  readonly name = "hang";
  started = 0;
  answer = false;
  /** How many more runs find every account at its usage limit. */
  limitTimes = 0;
  async run(request: AgentRunRequest) {
    this.started++;
    if (this.limitTimes-- > 0) return { status: "failed" as const, result: null, error: "You've hit your 5-hour limit", costUsd: 0, sessionId: null };
    if (this.answer) return { status: "succeeded" as const, result: "Done after the restart.", error: null, costUsd: 0, sessionId: null };
    await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve()));
    return { status: "failed" as const, result: null, error: "Aborted", costUsd: 0, sessionId: null };
  }
}

describe.skipIf(!DB_URL)("a server restart while an agent is working", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new HangingRunner();

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner, env: { AGENT_LIMIT_RETRY_SECONDS: "0.2" } });
  });
  afterAll(async () => {
    await ctx?.server.stop();
  });

  it("puts the task back on the queue at once, and it runs again when the server is back", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "check the orders" } });
    const id = body.task.id as string;
    const task = async () => (await ctx.api(`/api/tasks/${id}`)).body;
    for (let i = 0; i < 200 && runner.started === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await task()).task.status).toBe("running");

    // SIGTERM: the run is cut short and the task waits to start again. Nothing is reported as failed.
    ctx.notifier.sent.length = 0;
    expect(await ctx.server.pipeline.shutdown()).toEqual([id]);
    await ctx.queue.drain();
    const stopped = await task();
    expect(stopped.task).toMatchObject({ status: "queued", note: INTERRUPTED_NOTE });
    expect(stopped.runs).toHaveLength(1);
    expect(stopped.runs[0]).toMatchObject({ status: "failed", error: INTERRUPTED_ERROR });
    expect(ctx.notifier.sent).toEqual([]);

    // The next boot enqueues queued tasks: it runs again and finishes, with no 20-minute wait.
    runner.answer = true;
    expect((await ctx.server.pipeline.enqueueQueued()).map((t) => t.id)).toContain(id);
    await ctx.queue.drain();
    const after = await task();
    expect(after.task.status).toBe("done");
    expect(after.runs.map((r: { status: string }) => r.status)).toEqual(["failed", "succeeded"]);
    expect(runner.started).toBe(2);
  });

  it("starts again a task whose run died without a word (a crash)", async () => {
    runner.answer = true;
    const store = ctx.server.store;
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "check the parcels" } });
    await ctx.queue.drain();
    const id = body.task.id as string;
    // As if the process running it had been killed: the task says "running" and nothing is behind it.
    await store.pool.query("update tasks set status = 'running', updated_at = now() - interval '1 minute' where id = $1", [id]);
    // Heard from a minute ago: it may well be alive, so it is left alone.
    expect(await ctx.server.pipeline.recoverStale()).toEqual([]);
    await store.pool.query("update tasks set updated_at = now() - interval '4 minutes' where id = $1", [id]);
    const recovered = await ctx.server.pipeline.recoverStale();
    expect(recovered.map((t) => t.id)).toEqual([id]);
    expect(recovered[0]).toMatchObject({ status: "queued", note: INTERRUPTED_NOTE });
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${id}`)).body.task.status).toBe("done");
  });

  it("says it is alive while it runs", async () => {
    const store = ctx.server.store;
    const { rows } = await store.pool.query("select id from tasks limit 1");
    await store.pool.query("update tasks set status = 'running', updated_at = now() - interval '2 minutes' where id = $1", [rows[0].id]);
    await store.touchRunningTask(rows[0].id);
    const after = await store.pool.query("select updated_at > now() - interval '10 seconds' as fresh from tasks where id = $1", [rows[0].id]);
    expect(after.rows[0].fresh).toBe(true);
    await store.pool.query("update tasks set status = 'done' where id = $1", [rows[0].id]);
  });

  it("waits and tries again when the usage limit is reached, instead of failing", async () => {
    runner.answer = true;
    runner.limitTimes = 1; // the limit has passed by the second try
    ctx.notifier.sent.length = 0;
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "count the stock" } });
    const id = body.task.id as string;
    await ctx.queue.drain();
    const done = (await ctx.api(`/api/tasks/${id}`)).body;
    expect(done.task).toMatchObject({ status: "done", note: null });
    expect(done.runs.map((r: { status: string }) => r.status)).toEqual(["failed", "succeeded"]);
    // Dave asked for it and wasn't looking: told once that it was waiting (not that it failed), then the answer.
    expect(ctx.notifier.sent.map((n) => n.title)).toEqual(["Waiting for the usage limit: count the stock", "count the stock"]);
    expect(ctx.notifier.sent[0]!.body).toMatch(/tries again at \d\d:\d\d and carries on by itself/);
  });

  it("says why it is waiting while it waits", async () => {
    runner.limitTimes = 1;
    const made = await ctx.server.pipeline.ingest({ source: "webhook", vertical: "dms", kind: "ping", title: "An order", payload: { text: "x" } });
    // Caught between the first try and the next.
    let seen: { status: string; note: string | null } | null = null;
    for (let i = 0; i < 200 && !seen; i++) {
      const t = (await ctx.api(`/api/tasks/${made!.task.id}`)).body.task;
      if (t.status === "queued" && t.note) seen = t;
      else await new Promise((r) => setTimeout(r, 5));
    }
    expect(seen!.note).toContain(LIMIT_NOTE);
    expect(seen!.note).toMatch(/Trying again at \d\d:\d\d\./);
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${made!.task.id}`)).body.task.status).toBe("done");
  });

  it("gives up after enough tries at the limit, and says so", async () => {
    runner.limitTimes = Infinity;
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "count the parcels" } });
    const id = body.task.id as string;
    await ctx.queue.drain();
    const failed = (await ctx.api(`/api/tasks/${id}`)).body;
    expect(failed.task.status).toBe("failed");
    expect(failed.task.note).toBe("Run failed: You've hit your 5-hour limit");
    expect(failed.runs).toHaveLength(LIMIT_RETRIES + 1);
    runner.limitTimes = 0;
  });

  it("does nothing when no agent is working", async () => {
    expect(await ctx.server.pipeline.shutdown()).toEqual([]);
  });
});
