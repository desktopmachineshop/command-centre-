import type { AgentRunner, AgentRunRequest, AgentRunResult } from "@cc/agent-runtime";
import { STOPPED_NOTE } from "@cc/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

/** Runs until its signal aborts, like a Claude Code run killed with SIGTERM; prompts with "quick" finish at once. */
class BlockingRunner implements AgentRunner {
  readonly name = "blocking";
  readonly requests: AgentRunRequest[] = [];
  private waiting: (() => void)[] = [];

  run(request: AgentRunRequest, onMessage: (m: { type: "text"; text: string }) => void = () => {}): Promise<AgentRunResult> {
    this.requests.push(request);
    onMessage({ type: "text", text: "working on it" });
    if (request.prompt.includes("quick")) return Promise.resolve({ status: "succeeded", result: "done", error: null, costUsd: 0, sessionId: "s1" });
    return new Promise((resolve) => {
      request.signal?.addEventListener("abort", () => resolve({ status: "failed", result: null, error: "Aborted", costUsd: null, sessionId: "s2" }), { once: true });
      this.waiting.forEach((w) => w());
      this.waiting = [];
    });
  }

  /** Resolves once `n` runs have started. */
  started(n: number): Promise<void> {
    if (this.requests.length >= n) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(() => void this.started(n).then(resolve)));
  }
}

describe.skipIf(!DB_URL)("stopping agents", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new BlockingRunner();
  const task = async (id: string) => (await ctx.api(`/api/tasks/${id}`)).body.task as { status: string; note: string | null };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
  });
  afterAll(async () => ctx?.server.stop());

  it("stops a running task, which can then be continued with a reply", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: count every part in stock" } });
    await runner.started(1);
    expect((await task(body.task.id)).status).toBe("running");

    const stop = await ctx.api(`/api/tasks/${body.task.id}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
    await ctx.queue.drain();
    expect(await task(body.task.id)).toMatchObject({ status: "failed", note: STOPPED_NOTE });
    expect(runner.requests[0]!.signal?.aborted).toBe(true);

    // "Stop and edit": the corrected message continues the stopped task.
    const reply = await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "quick: only the collets" } });
    expect(reply.status).toBe(202);
    await ctx.queue.drain();
    expect(await task(body.task.id)).toMatchObject({ status: "done", note: null });
    expect(runner.requests.at(-1)!.prompt).toContain("only the collets");
  });

  it("stops all agents: running and queued work alike", async () => {
    const a = (await ctx.api("/api/chat", { method: "POST", json: { text: "dms: long job one" } })).body.task.id;
    const b = (await ctx.api("/api/chat", { method: "POST", json: { text: "personal: long job two" } })).body.task.id;
    const before = runner.requests.length;
    await runner.started(before);
    const stop = await ctx.api("/api/tasks/stop-all", { method: "POST" });
    expect(stop.status).toBe(200);
    expect(stop.body.stopped.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([a, b]));
    await ctx.queue.drain();
    expect(await task(a)).toMatchObject({ status: "failed", note: STOPPED_NOTE });
    expect(await task(b)).toMatchObject({ status: "failed", note: STOPPED_NOTE });
    // Nothing is left running.
    expect((await ctx.api("/api/tasks?status=running")).body).toEqual([]);
  });

  it("404s for an unknown task", async () => {
    expect((await ctx.api("/api/tasks/00000000-0000-4000-8000-000000000000/stop", { method: "POST" })).status).toBe(404);
  });
});
