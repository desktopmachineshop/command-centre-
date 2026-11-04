import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
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
    // Plus read-only access to files attached in the chat box, read and write in this task's own scratch
    // folder, and read access to the role's own skill folders (their supporting files live in the bank).
    const scratch = realpathSync(join(request.cwd!, "scratch", body.task.id));
    expect(request.allowedTools).toEqual([
      "Skill", "mcp__actions", "mcp__brain", "mcp__pa", "WebSearch", "WebFetch",
      expect.stringMatching(/^Read\(\/\/.*\/chat-files\/\*\*\)$/),
      `Read(/${scratch}/**)`,
      `Write(/${scratch}/**)`,
      `Edit(/${scratch}/**)`,
      expect.stringMatching(/^Read\(\/\/.*\/skills\/brain-notes\/\*\*\)$/),
    ]);
    expect(existsSync(join(request.cwd!, "scratch", body.task.id))).toBe(true);
    expect(request.systemPrompt).toContain("## Scratch folder");
    expect(request.systemPrompt).toContain("You can search the web (WebSearch) and read pages (WebFetch)");
    expect(request.cwd).toMatch(/workspaces\/dms\/shop-lead$/);
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

  it("lets Dave edit a pending proposal before approving it", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: { actionType: "brain.journal", summary: "Log the delivery", payload: { text: "Parcel arrived" } },
    });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "log the parcel" } });
    await ctx.queue.drain();
    const [proposal] = (await ctx.api("/api/proposals?status=pending")).body.filter((p: any) => p.taskId === body.task.id);

    const edited = await ctx.api(`/api/proposals/${proposal.id}`, { method: "PATCH", json: { payload: { text: "Parcel from Spindle Supplies arrived, 2 boxes" } } });
    expect(edited.body).toMatchObject({ status: "pending", payload: { text: "Parcel from Spindle Supplies arrived, 2 boxes" } });
    expect((await ctx.api(`/api/proposals/${proposal.id}`, { method: "PATCH", json: { payload: "nope" } })).status).toBe(400);

    expect((await ctx.api(`/api/proposals/${proposal.id}/approve`, { method: "POST" })).body.status).toBe("executed");
    const journal = await ctx.server.brain.read((await ctx.server.brain.list("journal")).at(-1)!);
    expect(journal?.body).toContain("Parcel from Spindle Supplies arrived, 2 boxes");
    expect((await ctx.api(`/api/proposals/${proposal.id}`, { method: "PATCH", json: { payload: { text: "late" } } })).status).toBe(409);
  });

  it("asks the agent for changes: rejects the proposal and continues its task with Dave's feedback", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: { actionType: "brain.journal", summary: "Log the call", payload: { text: "Called the courier" } },
    });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "log the courier call" } });
    await ctx.queue.drain();
    const [proposal] = (await ctx.api("/api/proposals?status=pending")).body.filter((p: any) => p.taskId === body.task.id);
    expect((await ctx.api(`/api/proposals/${proposal.id}/revise`, { method: "POST", json: { feedback: "  " } })).status).toBe(400);

    const runsBefore = runner.requests.length;
    const revised = await ctx.api(`/api/proposals/${proposal.id}/revise`, { method: "POST", json: { feedback: "Say it was Royal Mail, and the parcel ref." } });
    expect(revised.status).toBe(200);
    expect(revised.body.proposal.status).toBe("rejected");
    expect(revised.body.task.status).toBe("queued");
    await ctx.queue.drain();

    // The agent ran again on the same task, told what Dave wants changed, and proposed again.
    expect(runner.requests.length).toBe(runsBefore + 1);
    const prompt = runner.requests.at(-1)!.prompt;
    expect(prompt).toContain('did not approve your proposed brain.journal ("Log the call")');
    expect(prompt).toContain("Say it was Royal Mail, and the parcel ref.");
    const again = (await ctx.api("/api/proposals?status=pending")).body.filter((p: any) => p.taskId === body.task.id);
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(proposal.id);
    expect((await ctx.api(`/api/proposals/${proposal.id}/revise`, { method: "POST", json: { feedback: "again" } })).status).toBe(409);
    await ctx.api(`/api/proposals/${again[0].id}/approve`, { method: "POST" });
  });

  it("doesn't mark a task done over a reply that re-queued it while its approval settled", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: { actionType: "brain.journal", summary: "Log the tool order", payload: { text: "Ordered ER16 collets" } },
    });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "log that I ordered collets" } });
    await ctx.queue.drain();
    const [proposal] = (await ctx.api(`/api/proposals?status=pending`)).body.filter((p: any) => p.taskId === body.task.id);
    const store = ctx.server.store;
    const original = store.listProposals.bind(store);
    // A reply lands between settleTask reading the task and updating it.
    store.listProposals = async (...args: Parameters<typeof original>) => {
      if (args[0]?.taskId === body.task.id) await store.pool.query("update tasks set status = 'queued' where id = $1", [body.task.id]);
      return original(...args);
    };
    try {
      expect((await ctx.api(`/api/proposals/${proposal.id}/approve`, { method: "POST" })).body.status).toBe("executed");
    } finally {
      store.listProposals = original;
    }
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.task.status).toBe("queued");
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

  it("installs a role's missing software on one computer only, and picks up what it installed", async () => {
    const studioFrames: string[] = [];
    const otherFrames: string[] = [];
    const winget = { platform: "win32", installer: "winget" as const, installed: ["ffmpeg" as const] };
    const peers: Record<string, Peer> = { "other-pc": { send: (d) => otherFrames.push(d) }, "studio-pc": { send: (d) => studioFrames.push(d) }, "old-pc": { send: () => {} } };
    await ctx.server.workers.connect({ id: "other-pc", name: "Other PC", capabilities: [], setup: { ...winget, installed: [] } }, peers["other-pc"]!);
    await ctx.server.workers.connect({ id: "studio-pc", name: "Studio PC", capabilities: ["ffmpeg"], setup: winget }, peers["studio-pc"]!);
    await ctx.server.workers.connect({ id: "old-pc", name: "Old PC", capabilities: [] }, peers["old-pc"]!);
    expect((await ctx.api("/api/nodes")).body.find((n: any) => n.id === "studio-pc").setup).toEqual(winget);

    const res = await ctx.api("/api/nodes/studio-pc/setup", { method: "POST", json: { role: "media" } });
    expect(res.status).toBe(201);
    // Only what's missing and installable from here: Chrome (no GPU or DaVinci).
    expect(res.body).toMatchObject({ kind: "setup.install", targetNodeId: "studio-pc", payload: { role: "media", components: ["browser"] } });
    expect(studioFrames.some((f) => f.includes(`"job.assign"`) && f.includes(res.body.id))).toBe(true);
    expect(otherFrames.some((f) => f.includes(res.body.id))).toBe(false);

    // One install at a time per computer; unknown roles, computers and older apps are refused.
    expect((await ctx.api("/api/nodes/studio-pc/setup", { method: "POST", json: { role: "claude" } })).status).toBe(409);
    expect((await ctx.api("/api/nodes/studio-pc/setup", { method: "POST", json: { role: "everything" } })).status).toBe(400);
    expect((await ctx.api("/api/nodes/nope/setup", { method: "POST", json: { role: "media" } })).status).toBe(404);
    expect((await ctx.api("/api/nodes/old-pc/setup", { method: "POST", json: { role: "media" } })).body.error).toMatch(/older desktop app/);

    // The worker installed it, says what it has now, and finishes the job.
    await ctx.server.workers.handle("studio-pc", { type: "worker.capabilities", capabilities: ["ffmpeg", "browser"], setup: { ...winget, installed: ["ffmpeg", "browser"] } });
    await ctx.server.workers.handle("studio-pc", { type: "job.complete", jobId: res.body.id, result: { installed: ["browser"] } });
    const studio = (await ctx.api("/api/nodes")).body.find((n: any) => n.id === "studio-pc");
    expect(studio).toMatchObject({ capabilities: ["ffmpeg", "browser"], setup: { installed: ["ffmpeg", "browser"] } });
    expect((await ctx.api("/api/nodes/studio-pc/setup", { method: "POST", json: { role: "media" } })).body.error).toMatch(/has everything/);

    // A capture job now goes to it.
    const capture = (await ctx.api("/api/jobs", { method: "POST", json: { kind: "video.capture", requires: ["browser"] } })).body;
    expect(studioFrames.some((f) => f.includes(`"job.assign"`) && f.includes(capture.id))).toBe(true);
    await ctx.server.workers.handle("studio-pc", { type: "job.complete", jobId: capture.id, result: null });
    for (const [id, peer] of Object.entries(peers)) await ctx.server.workers.disconnect(id, peer);
  });

  it("pushes an update to a computer's desktop app, only when it's online and can take it", async () => {
    const frames: string[] = [];
    const peer: Peer = { send: (d) => frames.push(d) };
    const setup = { platform: "win32", installer: null, installed: [], appVersion: "0.1.40", remoteUpdate: true };
    await ctx.server.workers.connect({ id: "update-pc", name: "Update PC", capabilities: [], setup }, peer);
    expect((await ctx.api("/api/nodes/update-pc/update", { method: "POST" })).status).toBe(202);
    expect(frames.filter((f) => JSON.parse(f).type === "app.update")).toHaveLength(1);

    await ctx.server.workers.disconnect("update-pc", peer);
    const offline = await ctx.api("/api/nodes/update-pc/update", { method: "POST" });
    expect(offline.status).toBe(409);
    expect(offline.body.error).toMatch(/offline/);

    // An older app doesn't say it can take one: update it from its tray once.
    await ctx.server.workers.connect({ id: "update-pc", name: "Update PC", capabilities: [], setup: { ...setup, remoteUpdate: undefined } }, peer);
    expect((await ctx.api("/api/nodes/update-pc/update", { method: "POST" })).body.error).toMatch(/tray menu/);
    expect(frames.filter((f) => JSON.parse(f).type === "app.update")).toHaveLength(1);
    await ctx.server.workers.disconnect("update-pc", peer);
  });

  it("cancels a job still waiting for a computer, and only then", async () => {
    // No connected computer has a browser, so it stays queued.
    const job = (await ctx.api("/api/jobs", { method: "POST", json: { kind: "video.capture", requires: ["browser"] } })).body;
    expect(job.status).toBe("queued");
    const cancelled = await ctx.api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: job.id, status: "cancelled" });
    // A cancelled job is never handed out later.
    const frames: string[] = [];
    await ctx.server.workers.connect({ id: "browser-pc", name: "Browser PC", capabilities: ["browser"] }, { send: (d) => frames.push(d) });
    expect(frames.some((f) => f.includes(job.id))).toBe(false);
    expect((await ctx.api(`/api/jobs/${job.id}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await ctx.api("/api/jobs/00000000-0000-4000-8000-000000000000/cancel", { method: "POST" })).status).toBe(404);
    expect((await ctx.api("/api/jobs/not-a-job/cancel", { method: "POST" })).status).toBe(404);
  });

  it("reports stats", async () => {
    const stats = (await ctx.api("/api/stats")).body;
    expect(stats.costTodayUsd).toBeGreaterThan(0);
    expect(stats.pendingApprovals).toBe(0);
  });


  it("edits brain notes from the app, with history, conflicts and restore", async () => {
    const path = "dms/edited.md";
    const created = await ctx.api("/api/brain/note", { method: "PUT", json: { path, raw: "---\ntype: note\n---\n\n# Edited\n\nv1\n", expectedVersion: 0 } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ path, version: 1, updatedBy: "admin", frontmatter: { type: "note" } });
    expect((await ctx.api("/api/brain/note", { method: "PUT", json: { path, raw: "# Clash", expectedVersion: 0 } })).status).toBe(409);
    expect((await ctx.api("/api/brain/note", { method: "PUT", json: { path: "../x.md", raw: "x" } })).status).toBe(400);

    await ctx.api("/api/brain/note", { method: "PUT", json: { path, raw: "# Edited\n\nv2\n", expectedVersion: 1 } });
    const history = (await ctx.api(`/api/brain/history?path=${encodeURIComponent(path)}`)).body;
    expect(history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    expect((await ctx.api(`/api/brain/version?path=${encodeURIComponent(path)}&version=1`)).body.body).toContain("v1");

    const restored = await ctx.api("/api/brain/restore", { method: "POST", json: { path, version: 1 } });
    expect(restored.body).toMatchObject({ version: 3, frontmatter: { type: "note" } });
    expect((await ctx.api(`/api/brain/search?q=edited`)).body[0].path).toBe(path);

    expect((await ctx.api(`/api/brain/note?path=${encodeURIComponent(path)}&expectedVersion=3`, { method: "DELETE" })).status).toBe(200);
    expect((await ctx.api(`/api/brain/note?path=${encodeURIComponent(path)}`)).status).toBe(404);
  });

  it("seeds the brain with the overnight summary", async () => {
    expect((await ctx.server.brain.read("command-centre/2026-10-24-overnight-summary.md"))?.body).toContain("overnight summary");
  });
});
