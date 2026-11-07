import { ROOT_ROLE_ID } from "@cc/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HandoffError } from "../src/pipeline";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

type Call = { server: string; tool: string; args: Record<string, unknown> };

describe.skipIf(!DB_URL)("agent mode: single assistant", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new McpCallingRunner([]);
  const calls = (runner as unknown as { calls: Call[] }).calls;
  const chat = async (text: string) => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text } });
    await ctx.queue.drain();
    return body.task as { id: string; role: string; vertical: string };
  };
  const detail = async (id: string) => (await ctx.api(`/api/tasks/${id}`)).body;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner, env: { AGENT_MODE: "assistant" } });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    calls.length = 0;
    runner.requests.length = 0;
  });

  it("takes a chat that names a business itself, with every business's servers", async () => {
    // ops belongs to the Command Centre business: the Chief of Staff couldn't reach it in the org chart.
    calls.push({ server: "ops", tool: "performance", args: { days: 1 } });
    const task = await chat("dms: how did the agents do today?");
    expect(task.role).toBe(ROOT_ROLE_ID);
    const request = runner.requests[0]!;
    expect(Object.keys(request.mcpServers!)).toEqual(expect.arrayContaining(["actions", "brain", "pa", "ops"]));
    const run = (await detail(task.id)).runs[0];
    expect(run.status).toBe("succeeded");
    expect(run.result).not.toMatch(/may not use ops/);
    expect(request.systemPrompt).toContain("You are Dave's assistant");
    expect(request.systemPrompt).toContain("command-centre/software-lead");
    expect(request.systemPrompt).not.toContain("dms/shop-lead");
  });

  it("names the business on each proposal", async () => {
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "Tell Dave the collets are in", payload: { title: "Collets", body: "In stock" }, vertical: "dms" } });
    const task = await chat("remind me the collets are in");
    const { proposals } = await detail(task.id);
    expect(proposals.map((p: { vertical: string }) => p.vertical)).toEqual(["dms"]);
  });

  it("hands off only to the specialists, and a chat naming one goes straight to it", async () => {
    const task = await chat("what's on today?");
    await expect(ctx.server.pipeline.handoff(task.id, "dms/shop-lead", "Check orders")).rejects.toThrow(HandoffError);
    const { task: handed } = await ctx.server.pipeline.handoff(task.id, "command-centre/software-lead", "Fix the chat bug");
    expect(handed).toMatchObject({ vertical: "command-centre", role: "software-lead" });
    await ctx.queue.drain();

    const video = await chat("video: make a reel of the new collet set");
    expect(video).toMatchObject({ vertical: "3dpandme", role: "video-producer" });
  });

  it("switches back to the org chart from the Accounts page", async () => {
    const save = await ctx.api("/api/integrations/agents/default", { method: "PUT", json: { data: { route: "claude", mode: "org" } } });
    expect(save.status).toBeLessThan(300);
    const task = await chat("dms: what sold yesterday?");
    expect(task.role).not.toBe(ROOT_ROLE_ID);
    expect(runner.requests.at(-1)!.systemPrompt).not.toContain("You are Dave's assistant");
  });
});
