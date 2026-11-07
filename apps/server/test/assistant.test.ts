import { ROOT_ROLE_ID } from "@cc/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HandoffError } from "../src/pipeline";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase, WEBHOOK } from "./helpers";

type Call = { server: string; tool: string; args: Record<string, unknown> };

describe.skipIf(!DB_URL)("the assistant", () => {
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
    ctx = await makeServer({ runner });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    calls.length = 0;
    runner.requests.length = 0;
  });

  it("takes a chat about any business itself, with every business's servers", async () => {
    // ops belongs to the Command Centre business: the assistant reaches it from a DMS chat.
    calls.push({ server: "ops", tool: "performance", args: { days: 1 } });
    const task = await chat("dms: how did the agents do today?");
    expect(task).toMatchObject({ role: ROOT_ROLE_ID, vertical: "dms" });
    const request = runner.requests[0]!;
    expect(Object.keys(request.mcpServers!)).toEqual(expect.arrayContaining(["actions", "brain", "pa", "ops"]));
    expect((await detail(task.id)).runs[0].status).toBe("succeeded");
    expect(request.systemPrompt).toContain("You are Dave's assistant");
    expect(request.systemPrompt).toContain("command-centre/software-lead");
    expect(request.systemPrompt).toContain('how-we-work note "dms/how-we-work.md"');
    expect(request.cwd).toMatch(/workspaces\/dms\/chief-of-staff$/);
  });

  it("names the business on each proposal", async () => {
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "Tell Dave the collets are in", payload: { title: "Collets", body: "In stock" }, vertical: "dms" } });
    const task = await chat("remind me the collets are in");
    const { proposals } = await detail(task.id);
    expect(proposals.map((p: { vertical: string }) => p.vertical)).toEqual(["dms"]);
  });

  it("takes outside input too, with only that business's servers and its proposals kept to that business", async () => {
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "New signup", payload: { title: "Signup", body: "x" }, vertical: "personal" } });
    const res = await ctx.server.app.request("/api/ingress/webhook/opend?kind=signup", {
      method: "POST",
      headers: { "x-cc-webhook-secret": WEBHOOK, "content-type": "application/json" },
      body: JSON.stringify({ title: "New signup" }),
    });
    const { task } = (await res.json()) as { task: { id: string; role: string; vertical: string } };
    await ctx.queue.drain();
    expect(task).toMatchObject({ role: ROOT_ROLE_ID, vertical: "opend" });
    const request = runner.requests.at(-1)!;
    expect(Object.keys(request.mcpServers!)).not.toContain("ops");
    expect(request.systemPrompt).toContain("This task came from outside input, so you have only OpenD's tools");
    const { proposals } = await detail(task.id);
    expect(proposals.map((p: { vertical: string; policy: string }) => [p.vertical, p.policy])).toEqual([["opend", "draft"]]);
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

  it("seeds each business's how-we-work note in the brain, once", async () => {
    const note = (await ctx.api(`/api/brain/note?path=${encodeURIComponent("dms/how-we-work.md")}`)).body;
    expect(note.body).toMatch(/^# How we work: Desktop Machine Shop/);
    expect(note.body).toContain("## Customer Support");
  });
});
