import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Peer } from "../src/hub";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase, WEBHOOK } from "./helpers";

describe.skipIf(!DB_URL)("server (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new McpCallingRunner([]);
  const calls = (runner as any).calls as { server: string; tool: string; args: Record<string, unknown> }[];

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

  it("serves health", async () => {
    const res = await ctx.server.app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("requires the admin token", async () => {
    expect((await ctx.api("/api/tasks", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await ctx.api("/api/tasks")).status).toBe(200);
  });

  it("runs a chat request through triage and the agent", async () => {
    const { status, body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: what sold yesterday?" } });
    expect(status).toBe(201);
    expect(body.task).toMatchObject({ vertical: "dms", route: "agent", status: "queued" });
    await ctx.queue.drain();

    const detail = (await ctx.api(`/api/tasks/${body.task.id}`)).body;
    expect(detail.task.status).toBe("done");
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: "succeeded", costUsd: 0.02 });

    const request = runner.requests[0]!;
    expect(request.prompt).toBe("dms: what sold yesterday?");
    expect(request.systemPrompt).toContain("Desktop Machine Shop");
    expect(Object.keys(request.mcpServers!)).toEqual(["actions", "brain", "pa"]);
    expect(request.allowedTools).toEqual(["Skill", "mcp__actions", "mcp__brain", "mcp__pa"]);
    expect(request.cwd).toMatch(/workspaces\/dms$/);
  });

  it("holds draft actions for approval, then executes on approve", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: { actionType: "brain.journal", summary: "Log the stock check", payload: { text: "Checked ER11 stock" } },
    });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "log that I checked stock" } });
    await ctx.queue.drain();

    const pending = (await ctx.api("/api/proposals?status=pending")).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ actionType: "brain.journal", policy: "draft", taskId: body.task.id, vertical: "personal" });
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.task.status).toBe("awaiting_approval");
    expect(ctx.notifier.sent.at(-1)).toMatchObject({ body: "Log the stock check" });

    const approved = await ctx.api(`/api/proposals/${pending[0].id}/approve`, { method: "POST" });
    expect(approved.body.status).toBe("executed");
    expect((await ctx.api(`/api/proposals/${pending[0].id}/approve`, { method: "POST" })).status).toBe(409);

    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.task.status).toBe("done");
    const journal = await ctx.server.brain.list("journal");
    const note = await ctx.server.brain.read(journal.at(-1)!);
    expect(note?.body).toContain("Checked ER11 stock");
  });

  it("executes auto-policy actions straight away", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: { actionType: "brain.write", summary: "Save FAQ", payload: { path: "dms/faq.md", body: "# FAQ\n\nShips in 2 days." } },
    });
    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: save the shipping faq" } });
    await ctx.queue.drain();
    expect((await ctx.server.brain.read("dms/faq.md"))?.body).toContain("Ships in 2 days.");
  });

  it("lets agents use the brain MCP server", async () => {
    calls.push({ server: "brain", tool: "search", args: { query: "ships" } });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: how fast do we ship?" } });
    await ctx.queue.drain();
    const run = (await ctx.api(`/api/tasks/${body.task.id}`)).body.runs[0];
    expect(run.result).toContain("dms/faq.md");
  });

  it("rejects unknown action types back to the agent", async () => {
    calls.push({ server: "actions", tool: "propose_action", args: { actionType: "launch.rockets", summary: "x" } });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "do something odd" } });
    await ctx.queue.drain();
    const run = (await ctx.api(`/api/tasks/${body.task.id}`)).body.runs[0];
    expect(run.result).toContain("Unknown action type");
  });

  it("refuses MCP calls without a valid token", async () => {
    const res = await ctx.server.app.request("/mcp/brain", { method: "POST", headers: { authorization: "Bearer run_fake" } });
    expect(res.status).toBe(401);
  });

  it("accepts webhooks with the secret and dedupes them", async () => {
    const send = () =>
      ctx.server.app.request("/api/ingress/webhook/opend?kind=signup", {
        method: "POST",
        headers: { "x-cc-webhook-secret": WEBHOOK, "x-cc-dedupe-key": "signup-42", "content-type": "application/json" },
        body: JSON.stringify({ title: "New signup" }),
      });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(200);
    const bad = await ctx.server.app.request("/api/ingress/webhook/opend", { method: "POST", headers: { "x-cc-webhook-secret": "wrong" } });
    expect(bad.status).toBe(401);
    await ctx.queue.drain();
    const events = (await ctx.api("/api/events")).body.filter((e: any) => e.dedupeKey === "signup-42");
    expect(events).toHaveLength(1);
  });

  it("dispatches jobs to capable worker nodes and requeues on disconnect", async () => {
    const frames = (sink: string[]): Peer => ({ send: (d) => sink.push(d) });
    const laptopFrames: string[] = [];
    const desktopFrames: string[] = [];
    const laptop = frames(laptopFrames);
    const desktop = frames(desktopFrames);

    await ctx.server.workers.connect({ id: "laptop", name: "Laptop", capabilities: ["ffmpeg"] }, laptop);
    const job = (await ctx.api("/api/jobs", { method: "POST", json: { kind: "render", requires: ["gpu", "ffmpeg"] } })).body;
    expect(job.status).toBe("queued");
    expect(laptopFrames.some((f) => f.includes("job.assign"))).toBe(false);

    await ctx.server.workers.connect({ id: "desktop", name: "Desktop", capabilities: ["gpu", "ffmpeg"] }, desktop);
    expect(desktopFrames.some((f) => f.includes(`"job.assign"`) && f.includes(job.id))).toBe(true);

    await ctx.server.workers.disconnect("desktop", desktop);
    const requeued = (await ctx.api("/api/jobs")).body.find((j: any) => j.id === job.id);
    expect(requeued).toMatchObject({ status: "queued", nodeId: null });

    await ctx.server.workers.connect({ id: "desktop", name: "Desktop", capabilities: ["gpu", "ffmpeg"] }, desktop);
    await ctx.server.workers.handle("desktop", { type: "job.complete", jobId: job.id, result: { file: "out.mp4" } });
    const done = (await ctx.api("/api/jobs")).body.find((j: any) => j.id === job.id);
    expect(done).toMatchObject({ status: "succeeded", result: { file: "out.mp4" } });

    const nodes = (await ctx.api("/api/nodes")).body;
    expect(nodes.map((n: any) => [n.id, n.online])).toEqual([["desktop", true], ["laptop", true]]);
  });

  it("reports stats", async () => {
    const stats = (await ctx.api("/api/stats")).body;
    expect(stats.costTodayUsd).toBeGreaterThan(0);
    expect(stats.pendingApprovals).toBe(0);
  });

});
