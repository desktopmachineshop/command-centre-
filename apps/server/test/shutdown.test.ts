import type { AgentRunner, AgentRunRequest } from "@cc/agent-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERRUPTED_ERROR, INTERRUPTED_NOTE } from "../src/pipeline";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

/** Runs until it is aborted (as a real agent would be when the server stops), unless told to answer. */
class HangingRunner implements AgentRunner {
  readonly name = "hang";
  started = 0;
  answer = false;
  async run(request: AgentRunRequest) {
    this.started++;
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
    ctx = await makeServer({ runner });
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

  it("does nothing when no agent is working", async () => {
    expect(await ctx.server.pipeline.shutdown()).toEqual([]);
  });
});
