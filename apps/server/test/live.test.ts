import { ScriptedRunner } from "@cc/agent-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

describe("live feed heartbeat", () => {
  it("pings app clients on an interval until stopped, and never workers", () => {
    vi.useFakeTimers();
    try {
      const hub = new Hub();
      const client: string[] = [];
      const worker: string[] = [];
      hub.addClient({ send: (d) => client.push(d) });
      hub.addWorker("pc", { send: (d) => worker.push(d) });
      const stop = hub.startHeartbeat(1000);
      vi.advanceTimersByTime(3500);
      expect(client).toEqual(Array(3).fill(JSON.stringify({ type: "ping" })));
      stop();
      vi.advanceTimersByTime(5000);
      expect(client).toHaveLength(3);
      expect(worker).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!DB_URL)("a failed run", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new ScriptedRunner("echo", (req) =>
    /silent/.test(req.prompt)
      ? { result: { status: "failed", result: null, error: null, costUsd: 0, sessionId: null } }
      : { result: { status: "failed", result: null, error: "Claude usage limit reached; resets at 03:00", costUsd: 0, sessionId: null } },
  );

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
  });
  afterAll(async () => {
    await ctx?.server.stop();
  });

  it("keeps why it failed on the task, where Chat and the Inbox show it", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "what sold best this week?" } });
    await ctx.queue.drain();
    const task = (await ctx.api(`/api/tasks/${body.task.id}`)).body.task;
    expect(task).toMatchObject({ status: "failed", note: "Run failed: Claude usage limit reached; resets at 03:00" });

    const silent = await ctx.api("/api/chat", { method: "POST", json: { text: "a silent failure" } });
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${silent.body.task.id}`)).body.task.note).toBe("Run failed: the agent stopped without saying why");
  });
});
