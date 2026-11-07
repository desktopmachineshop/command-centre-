import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, AgentRunRequest } from "@cc/agent-runtime";
import { ROOT_ROLE_ID, type OrgTree } from "@cc/core";
import { VerticalRegistry } from "@cc/verticals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { builtinExecutors } from "../src/actions";
import { roleBrief, systemPrompt } from "../src/agent-context";
import { assistantCharter, assistantRole } from "../src/assistant";
import { buildOrgTree } from "../src/org";
import { prepareWorkspace, skillReadRules } from "../src/workspace";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase, WEBHOOK } from "./helpers";

const registry = new VerticalRegistry();
const dms = registry.require("dms");
const channel = registry.require("3dpandme");

/** The brief the pipeline gives an assistant run (pipeline.ts runTask). */
const assistantBrief = (verticalId: string, handoffsLeft: number, trusted = true) => ({
  ...roleBrief(registry, verticalId, ROOT_ROLE_ID, handoffsLeft),
  assistant: assistantCharter(registry, registry.require(verticalId), handoffsLeft, trusted),
});

describe("role charter in the system prompt", () => {
  it("carries a specialist's title, mission, reporting line, autonomy and team", () => {
    const prompt = systemPrompt(channel, builtinExecutors, new Date("2026-10-23T09:00:00Z"), roleBrief(registry, "3dpandme", "video-producer", 3));
    const role = registry.roleFor("3dpandme", "video-producer");
    expect(prompt).toContain("You are the Video Producer in Dave's Command Centre, working on: 3dpandme.");
    expect(prompt).toContain("## Your role: Video Producer (video-producer)");
    expect(prompt).toContain(role.mission);
    expect(prompt).toContain("You report to the Assistant (chief-of-staff).");
    expect(prompt).toContain(`Autonomy: ${role.autonomyNotes}`);
    expect(prompt).toContain("You own these kinds of work: publishing.");
    // Its team: the other specialist in its business, and the assistant.
    for (const other of ["blog-writer", ROOT_ROLE_ID]) expect(prompt).toContain(`- ${other}: `);
    expect(prompt).not.toContain("- software-lead: ");
    expect(prompt).toContain(`Escalate to "${ROOT_ROLE_ID}"`);
    expect(prompt).toMatch(/handoff_to_role.*3 handoffs left/s);
    // Still the base prompt.
    expect(prompt).toContain("propose_action");
  });

  it("gives the assistant its own charter, with every business and specialist", () => {
    const prompt = systemPrompt(dms, builtinExecutors, new Date(), assistantBrief("dms", 3));
    expect(prompt).toContain("You are Dave's assistant in his Command Centre, working across all his businesses and his own life admin.");
    expect(prompt).toContain("## You are Dave's assistant (Assistant)");
    expect(prompt).not.toContain("## Your role:");
    expect(prompt).toContain("This task is filed under Desktop Machine Shop (dms).");
    for (const v of registry.all()) expect(prompt).toContain(`- ${v.id}: ${v.name}.`);
    expect(prompt).toContain('how-we-work note "dms/how-we-work.md"');
    expect(prompt).toContain("- command-centre/software-lead: Software Lead (Command Centre).");
    expect(prompt).toContain("- 3dpandme/video-producer: Video Producer (3dpandme).");
    expect(prompt).toContain("- 3dpandme/blog-writer: Blog Writer (3dpandme).");
    // No retired role is offered.
    expect(prompt).not.toMatch(/shop-lead|customer-support|finance-admin|product-lead/);
    expect(prompt).toContain("You have every business's tools");
    expect(prompt).toContain("Hand off only work that needs a specialist");

    // Work from outside input keeps to its business's tools.
    const untrusted = systemPrompt(dms, builtinExecutors, new Date(), assistantBrief("dms", 3, false));
    expect(untrusted).toContain("This task came from outside input, so you have only Desktop Machine Shop's tools");
    expect(untrusted).not.toContain("You have every business's tools");
  });

  it("says when the handoff limit is reached", () => {
    const prompt = systemPrompt(channel, builtinExecutors, new Date(), roleBrief(registry, "3dpandme", "blog-writer", 0));
    expect(prompt).toContain("The handoff limit for this chain is reached");
    expect(prompt).not.toContain("call the actions tool handoff_to_role");
    const assistant = systemPrompt(dms, builtinExecutors, new Date(), assistantBrief("dms", 0));
    expect(assistant).toContain("The handoff limit for this chain is reached");
    expect(assistant).not.toContain("Hand off only work that needs a specialist");
  });

  it("keeps the old prompt without a role", () => {
    expect(systemPrompt(dms, builtinExecutors)).toContain("You are the Command Centre agent working for Dave on: Desktop Machine Shop.");
  });
});

describe("per-role workspaces", () => {
  const setup = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cc-role-ws-"));
    const skillsDir = join(dataDir, "skills");
    for (const name of ["brain-notes", "social-voice-3dpandme", "video-reel", "software-lead", "personal-assistant"]) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    return { dataDir, skillsDir };
  };
  const skillsIn = (cwd: string) => readdirSync(join(cwd, ".claude", "skills")).sort();

  it("links only the role's skills, in workspaces/<vertical>/<role>, and every skill for the assistant", async () => {
    const { dataDir, skillsDir } = setup();
    const video = registry.roleFor("3dpandme", "video-producer");
    const blog = registry.roleFor("3dpandme", "blog-writer");
    const [a, b, c] = await Promise.all([
      prepareWorkspace(dataDir, skillsDir, channel, video),
      prepareWorkspace(dataDir, skillsDir, channel, blog),
      prepareWorkspace(dataDir, skillsDir, dms, assistantRole(registry)),
    ]);
    expect(a).toBe(join(dataDir, "workspaces", "3dpandme", "video-producer"));
    expect(b).toBe(join(dataDir, "workspaces", "3dpandme", "blog-writer"));
    expect(c).toBe(join(dataDir, "workspaces", "dms", ROOT_ROLE_ID));
    // Skills missing from the bank (social-platform-guide here) are skipped.
    expect(skillsIn(a)).toEqual(["brain-notes", "social-voice-3dpandme", "video-reel"]);
    expect(skillsIn(b)).toEqual(["brain-notes", "social-voice-3dpandme"]);
    // The assistant gets every skill some business or specialist lists.
    expect(skillsIn(c)).toEqual(["brain-notes", "personal-assistant", "social-voice-3dpandme", "software-lead", "video-reel"]);
    expect(lstatSync(join(b, ".claude", "skills", "social-voice-3dpandme")).isSymbolicLink()).toBe(true);
  });

  it("lets a run read its own skills' supporting files, and no other skill's", async () => {
    const { dataDir, skillsDir } = setup();
    mkdirSync(join(skillsDir, "social-voice-3dpandme", "refs"), { recursive: true });
    writeFileSync(join(skillsDir, "social-voice-3dpandme", "refs", "tone.md"), "Tone notes");
    const blog = registry.roleFor("3dpandme", "blog-writer");
    await prepareWorkspace(dataDir, skillsDir, channel, blog);
    const real = realpathSync(skillsDir);
    expect(skillReadRules(skillsDir, channel, blog)).toEqual([`Read(/${real}/brain-notes/**)`, `Read(/${real}/social-voice-3dpandme/**)`]);
    // Skills missing from the bank, and names that aren't plain folder names, get nothing.
    expect(skillReadRules(skillsDir, channel, { skills: ["social-platform-guide", "../software-lead", "brain-notes"] })).toEqual([`Read(/${real}/brain-notes/**)`]);
  });

  it("is safe to run concurrently for one role and clears the old vertical-level skills", async () => {
    const { dataDir, skillsDir } = setup();
    await prepareWorkspace(dataDir, skillsDir, channel); // the layout before roles
    expect(skillsIn(join(dataDir, "workspaces", "3dpandme")).length).toBeGreaterThan(0);
    const role = registry.roleFor("3dpandme", "blog-writer");
    const cwds = await Promise.all(Array.from({ length: 8 }, () => prepareWorkspace(dataDir, skillsDir, channel, role)));
    expect(new Set(cwds).size).toBe(1);
    expect(skillsIn(cwds[0]!)).toEqual(["brain-notes", "social-voice-3dpandme"]);
    expect(readdirSync(join(dataDir, "workspaces", "3dpandme"))).toEqual(["blog-writer"]);
  });
});

describe("org tree", () => {
  it("has the assistant at the root, then each business with its specialists and stats", () => {
    const tree = buildOrgTree(
      registry,
      [
        { vertical: "3dpandme", role: "video-producer", open: 2, done: 5, costUsd: 0.5, pending: 1 },
        { vertical: "dms", role: null, open: 1, done: 0, costUsd: 0.1, pending: 0 },
        // A retired role's tasks count towards the assistant.
        { vertical: "dms", role: "customer-support", open: 1, done: 0, costUsd: 0, pending: 0 },
        { vertical: "dms", role: ROOT_ROLE_ID, open: 0, done: 2, costUsd: 0.3, pending: 1 },
        { vertical: "personal", role: ROOT_ROLE_ID, open: 0, done: 3, costUsd: 0.2, pending: 1 },
        { vertical: "gone", role: null, open: 9, done: 9, costUsd: 9, pending: 9 },
      ],
      7,
    );
    expect(tree.windowDays).toBe(7);
    // The assistant's numbers are its tasks in every business.
    expect(tree.root).toMatchObject({
      id: ROOT_ROLE_ID,
      title: "Assistant",
      vertical: "personal",
      aliases: ["assistant", "cos", "chief", "chief-of-staff"],
      mcpServers: ["brain", "pa", "mail"],
      schedules: [{ id: "morning-brief", cron: "0 7 * * 1-5", timezone: "Europe/London", enabled: true }],
      stats: { openTasks: 2, doneTasks: 5, pendingApprovals: 2 },
    });
    expect(tree.root.stats.costUsd).toBeCloseTo(0.6);
    for (const gone of ["reportsTo", "children", "lead", "intents", "implicit"]) expect(tree.root).not.toHaveProperty(gone);
    expect(tree.root.verticals.map((v) => v.id)).toEqual(["personal", "dms", "3dpandme", "openv", "opend", "command-centre"]);

    const shop = tree.root.verticals.find((v) => v.id === "dms")!;
    expect(shop).toMatchObject({
      name: "Desktop Machine Shop",
      color: "#d9822b",
      brainFolder: "dms",
      defaultPolicy: dms.defaultPolicy,
      policies: dms.policies,
      dailyBudgetUsd: dms.dailyBudgetUsd ?? null,
      schedules: [{ id: "low-stock-check", cron: "15 8 * * 1-5", timezone: "Europe/London", enabled: false }],
      stats: { openTasks: 2, doneTasks: 2, pendingApprovals: 1 },
      specialists: [],
    });
    expect(shop).not.toHaveProperty("lead");

    // A business's numbers are the assistant's and its specialists' there.
    const pandme = tree.root.verticals.find((v) => v.id === "3dpandme")!;
    expect(pandme.stats).toMatchObject({ openTasks: 2, doneTasks: 5, costUsd: 0.5, pendingApprovals: 1 });
    expect(pandme.specialists.map((r) => r.id)).toEqual(["video-producer", "blog-writer"]);
    expect(pandme.specialists[0]).toMatchObject({
      vertical: "3dpandme",
      aliases: ["video", "youtube"],
      mcpServers: ["brain", "odoo"],
      stats: { openTasks: 2, doneTasks: 5, costUsd: 0.5, pendingApprovals: 1 },
    });
    expect(pandme.specialists[1]).toMatchObject({ id: "blog-writer", stats: { openTasks: 0, doneTasks: 0, costUsd: 0, pendingApprovals: 0 } });
    for (const gone of ["reportsTo", "children", "intents", "implicit"]) expect(pandme.specialists[0]).not.toHaveProperty(gone);

    const software = tree.root.verticals.find((v) => v.id === "command-centre")!.specialists;
    expect(software.map((r) => r.id)).toEqual(["software-lead"]);
    expect(software[0]!.schedules.map((s) => s.id)).toEqual(["file-issues", "assess-performance"]);

    // The assistant is not repeated as a specialist of its home business.
    const personal = tree.root.verticals[0]!;
    expect(personal.specialists).toEqual([]);
    expect(personal.stats.doneTasks).toBe(3);
  });
});

/** A runner whose MCP calls depend on the run's role (from its workspace path). */
class RoleRunner implements AgentRunner {
  readonly name = "role-test";
  app?: McpCallingRunner["app"];
  readonly requests: AgentRunRequest[] = [];
  readonly results: Record<string, string[]> = {};
  plan: Record<string, { server: string; tool: string; args: Record<string, unknown> }[]> = {};

  async run(request: AgentRunRequest) {
    this.requests.push(request);
    const key = request.cwd!.split("/").slice(-2).join("/");
    const inner = new McpCallingRunner(this.plan[key] ?? []);
    inner.app = this.app;
    const result = await inner.run(request);
    (this.results[key] ??= []).push(result.result);
    return result;
  }
}

const handoff = (roleId: string, note = "please take this") => ({ server: "actions", tool: "handoff_to_role", args: { roleId, note } });
const COS = `personal/${ROOT_ROLE_ID}`;

describe.skipIf(!DB_URL)("org roles (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new RoleRunner();

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner, env: { AGENT_MAX_CONCURRENT_PER_VERTICAL: "10" } });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    runner.plan = {};
    runner.requests.length = 0;
    for (const k of Object.keys(runner.results)) delete runner.results[k];
  });

  const tasks = async () => (await ctx.api("/api/tasks?limit=200")).body as { id: string; vertical: string; role: string; status: string; prompt: string; eventId: string }[];

  it("stores the routed role and runs in its workspace with its charter", async () => {
    // A chat naming a specialist goes to it, in its business.
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "video: plan the collet set video" } });
    expect(body.task).toMatchObject({ vertical: "3dpandme", role: "video-producer" });
    await ctx.queue.drain();
    const request = runner.requests[0]!;
    expect(request.cwd).toMatch(/workspaces\/3dpandme\/video-producer$/);
    expect(request.systemPrompt).toContain("## Your role: Video Producer (video-producer)");
    expect(readdirSync(join(request.cwd!, ".claude", "skills"))).toEqual(["brain-notes"]);
    // A specialist keeps to its own servers.
    expect(Object.keys(request.mcpServers!)).not.toContain("pa");
    expect(Object.keys(request.mcpServers!)).not.toContain("ops");

    // Anything else goes to the assistant, in the business it was triaged to.
    runner.requests.length = 0;
    const shop = (await ctx.api("/api/chat", { method: "POST", json: { text: "dms: what sold yesterday?" } })).body.task;
    expect(shop).toMatchObject({ vertical: "dms", role: ROOT_ROLE_ID });
    const cos = (await ctx.api("/api/chat", { method: "POST", json: { text: "cos: what matters today?" } })).body.task;
    expect(cos).toMatchObject({ vertical: "personal", role: ROOT_ROLE_ID });
    // A retired role's name is no longer a route: the assistant takes it.
    const retired = (await ctx.api("/api/chat", { method: "POST", json: { text: "support: where is order S00042?", vertical: "dms" } })).body.task;
    expect(retired).toMatchObject({ vertical: "dms", role: ROOT_ROLE_ID });
    await ctx.queue.drain();
    const shopRun = runner.requests.find((r) => r.prompt.includes("what sold yesterday"))!;
    expect(shopRun.cwd).toMatch(/workspaces\/dms\/chief-of-staff$/);
    expect(shopRun.systemPrompt).toContain("## You are Dave's assistant (Assistant)");
    expect(shopRun.systemPrompt).toContain("This task is filed under Desktop Machine Shop (dms).");
    // Work Dave started: every business's servers (ops is the Command Centre's).
    expect(Object.keys(shopRun.mcpServers!)).toEqual(expect.arrayContaining(["actions", "brain", "pa", "ops"]));
  });

  it("filters tasks by role", async () => {
    const video = (await ctx.api("/api/tasks?role=video-producer")).body;
    expect(video.length).toBeGreaterThan(0);
    expect(video.every((t: { role: string }) => t.role === "video-producer")).toBe(true);
    // The assistant's tasks are in every business.
    const cos = (await ctx.api(`/api/tasks?role=${ROOT_ROLE_ID}`)).body as { role: string | null; vertical: string }[];
    expect(new Set(cos.map((t) => t.role))).toEqual(new Set([ROOT_ROLE_ID]));
    expect(new Set(cos.map((t) => t.vertical))).toEqual(new Set(["dms", "personal"]));
    const shopOnly = (await ctx.api(`/api/tasks?vertical=dms&role=${ROOT_ROLE_ID}`)).body as { vertical: string }[];
    expect(shopOnly.length).toBe(2);
    expect(shopOnly.every((t) => t.vertical === "dms")).toBe(true);
    expect((await ctx.api("/api/tasks?vertical=nope&role=x")).status).toBe(404);
  });

  it("hands work on and reports back, never back to the assistant that started the chain, with a depth limit", async () => {
    // The assistant (in dms) -> Video Producer -> Blog Writer -> the assistant: refused, it is already in the chain.
    runner.plan = {
      [`dms/${ROOT_ROLE_ID}`]: [handoff("3dpandme/video-producer", "a video about the S00042 kit")],
      "3dpandme/video-producer": [handoff("blog")],
      "3dpandme/blog-writer": [handoff(ROOT_ROLE_ID)],
    };
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: please sort out the S00042 thread" } });
    expect(body.task).toMatchObject({ vertical: "dms", role: ROOT_ROLE_ID });
    await ctx.queue.drain();

    const chain = (await tasks()).filter((t) => t.prompt.includes("S00042 thread") && t.id !== body.task.id);
    expect(chain.map((t) => `${t.vertical}/${t.role}`).sort()).toEqual(["3dpandme/blog-writer", "3dpandme/video-producer"]);
    const first = chain.find((t) => t.role === "video-producer")!;
    expect(first.prompt).toContain("Handoff to you from the Assistant (Desktop Machine Shop).");
    expect(first.prompt).toContain("a video about the S00042 kit");
    expect(runner.results[`dms/${ROOT_ROLE_ID}`]![0]).toContain(`Handed off to video-producer in 3dpandme: task ${first.id}`);
    expect(first.prompt).toContain("your final summary goes back to the Assistant automatically");
    expect(chain.find((t) => t.role === "blog-writer")!.prompt).toContain("Handoff to you from the Video Producer (3dpandme).");
    expect(runner.results["3dpandme/blog-writer"]!.at(-1)).toContain("already worked on this chain");
    // Each role reported back up the chain, so the assistant ran again with the Video Producer's report.
    const assistantRuns = runner.requests.filter((r) => r.cwd!.endsWith(`dms/${ROOT_ROLE_ID}`));
    expect(assistantRuns).toHaveLength(2);
    expect(assistantRuns[1]!.prompt).toContain("Report back from the Video Producer (3dpandme), who took the work you handed off");
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.task.status).toBe("done");

    // A task already three handoffs down a chain may not hand on again.
    runner.plan = {};
    const deep = await ctx.server.pipeline.ingest({
      source: "system",
      vertical: "3dpandme",
      kind: "handoff",
      title: "Deep in a chain",
      payload: { prompt: "deep", role: "video-producer", depth: 3, chain: [], originSource: "chat" },
    });
    await ctx.queue.drain();
    await expect(ctx.server.pipeline.handoff(deep!.task.id, "blog", "more")).rejects.toThrow("Handoff limit reached (3 in a chain)");
  });

  it("refuses loops, self-handoffs, unknown and retired roles and cross-vertical handoffs below the assistant", async () => {
    runner.plan = {
      "3dpandme/video-producer": [
        handoff("video-producer"),
        handoff("nobody"),
        handoff("content-lead"),
        handoff("command-centre/software-lead"),
        handoff("blog"),
      ],
      "3dpandme/blog-writer": [handoff("video")],
    };
    await ctx.api("/api/chat", { method: "POST", json: { text: "video: loop test" } });
    await ctx.queue.drain();
    const video = runner.results["3dpandme/video-producer"]![0]!;
    const [self, unknown, retired, across, ok] = video.split("\n");
    expect(self).toContain("That is your own role");
    expect(unknown).toContain('Unknown role \\"nobody\\"');
    expect(retired).toContain('Unknown role \\"content-lead\\"');
    expect(across).toContain("Only the Assistant hands work across verticals");
    expect(ok).toContain("Handed off to blog-writer");
    expect(runner.results["3dpandme/blog-writer"]!.at(-1)).toContain("already worked on this chain (3dpandme/video-producer -> 3dpandme/blog-writer)");
  });

  it("escalates to the assistant, who can delegate to any business and sees every approval", async () => {
    await ctx.server.actions.propose({ vertical: "dms", actionType: "brain.journal", summary: "dms pending note", payload: { text: "x" } });
    runner.plan = {
      "command-centre/software-lead": [handoff(ROOT_ROLE_ID, "the release needs a blog post")],
      [COS]: [{ server: "actions", tool: "list_pending", args: {} }, handoff("3dpandme/blog-writer", "write up the release")],
    };
    await ctx.api("/api/chat", { method: "POST", json: { text: "software: ship the release notes" } });
    await ctx.queue.drain();
    const cos = runner.results[COS]![0]!;
    expect(cos).toContain("[dms] brain.journal: dms pending note");
    expect(cos).toContain("Handed off to blog-writer in 3dpandme");
    const escalated = (await tasks()).find((t) => t.vertical === "personal" && t.prompt.includes("the release needs a blog post"))!;
    expect(escalated.role).toBe(ROOT_ROLE_ID);
    expect(escalated.prompt).toContain("Handoff to you from the Software Lead (Command Centre).");
    const handed = (await tasks()).find((t) => t.vertical === "3dpandme" && t.prompt.includes("write up the release"))!;
    expect(handed.role).toBe("blog-writer");
    expect(handed.prompt).toContain("Handoff to you from the Assistant (Personal).");
  });

  it("sends a plain chat to the assistant, who hands specialist work on and gets the result back", async () => {
    runner.plan = {
      [COS]: [handoff("3dpandme/blog-writer", "Dave wants a post about the spindle upgrade")],
      "3dpandme/blog-writer": [{ server: "actions", tool: "propose_action", args: { actionType: "brain.journal", summary: "Log the spindle post", payload: { text: "Spindle post drafted" } } }],
    };
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "write up the spindle upgrade for the blog" } });
    expect(body.task).toMatchObject({ vertical: "personal", role: ROOT_ROLE_ID });
    await ctx.queue.drain();

    const cosRuns = runner.requests.filter((r) => r.cwd!.endsWith(COS));
    expect(cosRuns).toHaveLength(2);
    expect(cosRuns[0]!.systemPrompt).toContain("## You are Dave's assistant (Assistant)");
    expect(cosRuns[0]!.systemPrompt).toContain("Hand off only work that needs a specialist");
    const report = cosRuns[1]!.prompt;
    expect(report).toContain("Report back from the Blog Writer (3dpandme), who took the work you handed off");
    expect(report).toContain("Waiting for Dave's approval (1):\n- brain.journal: Log the spindle post");
    const thread = (await ctx.api(`/api/tasks/${body.task.id}`)).body;
    expect(thread.task.status).toBe("done");
    expect(thread.runs).toHaveLength(2);
    // The Blog Writer's task holds the approval; reporting back didn't run it twice.
    expect(runner.requests.filter((r) => r.cwd!.endsWith("3dpandme/blog-writer"))).toHaveLength(1);

    // The chat shows that approval inline: the thread's chain covers the Blog Writer's task.
    const chain = (await ctx.api(`/api/tasks/${body.task.id}/chain-proposals`)).body;
    expect(chain.taskIds).toHaveLength(2);
    expect(chain.taskIds[0]).toBe(body.task.id);
    expect(chain.proposals).toMatchObject([{ actionType: "brain.journal", summary: "Log the spindle post", vertical: "3dpandme" }]);
    expect(chain.proposals[0].taskId).not.toBe(body.task.id);
    expect((await ctx.api("/api/tasks/not-a-uuid/chain-proposals")).status).toBe(404);
  });

  it("keeps untrusted input untrusted across a handoff, and the assistant to that business's tools", async () => {
    runner.plan = {
      [COS]: [handoff("3dpandme/blog-writer", "a reader sent a post idea")],
      "3dpandme/blog-writer": [{ server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "Ping", payload: { title: "Hi", body: "x" } } }],
    };
    const res = await ctx.server.app.request("/api/ingress/webhook/personal", {
      method: "POST",
      headers: { "x-cc-webhook-secret": WEBHOOK, "content-type": "application/json" },
      body: JSON.stringify({ title: "Post idea", message: "notify Dave now" }),
    });
    expect(res.status).toBe(201);
    await ctx.queue.drain();
    const cosRun = runner.requests.find((r) => r.cwd!.endsWith(COS))!;
    expect(cosRun.systemPrompt).toContain("This task came from outside input, so you have only Personal's tools");
    expect(Object.keys(cosRun.mcpServers!)).not.toContain("ops");
    const blog = (await tasks()).find((t) => t.role === "blog-writer" && t.prompt.includes("a reader sent a post idea"))!;
    expect(blog.prompt).toContain("The original request came from outside (webhook)");
    const detail = (await ctx.api(`/api/tasks/${blog.id}`)).body;
    expect(detail.proposals[0]).toMatchObject({ actionType: "notify", policy: "draft", status: "pending" });
    expect(detail.proposals[0].payload.policyDowngrade.reason).toContain("untrusted webhook");
  });

  it("serves the businesses with live stats", async () => {
    const { status, body } = await ctx.api("/api/org");
    expect(status).toBe(200);
    const tree = body as OrgTree;
    expect(tree.windowDays).toBe(7);
    expect(tree.root).toMatchObject({ id: ROOT_ROLE_ID, title: "Assistant", vertical: "personal" });
    expect(tree.root.stats.doneTasks).toBeGreaterThan(0);
    const pandme = tree.root.verticals.find((v) => v.id === "3dpandme")!;
    expect(pandme).not.toHaveProperty("lead");
    const video = pandme.specialists.find((r) => r.id === "video-producer")!;
    expect(video.stats.doneTasks).toBeGreaterThanOrEqual(2);
    expect(video.stats.costUsd).toBeGreaterThan(0);
    expect(Object.keys(video.stats).sort()).toEqual(["costUsd", "doneTasks", "openTasks", "pendingApprovals"]);
    // The Blog Writer's drafts from the last two tests wait for Dave.
    const blog = pandme.specialists.find((r) => r.id === "blog-writer")!;
    expect(blog.stats.pendingApprovals).toBe(2);
    expect(pandme.stats.pendingApprovals).toBeGreaterThanOrEqual(2);
    // The dms approval proposed outside any task, and the assistant's dms work, count in dms.
    const shop = tree.root.verticals.find((v) => v.id === "dms")!;
    expect(shop.specialists).toEqual([]);
    expect(shop.stats.doneTasks).toBeGreaterThan(0);
  });
});
