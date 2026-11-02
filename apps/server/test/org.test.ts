import { lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, AgentRunRequest } from "@cc/agent-runtime";
import { ROOT_ROLE_ID, type OrgTree } from "@cc/core";
import { VerticalRegistry } from "@cc/verticals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { builtinExecutors } from "../src/actions";
import { roleBrief, systemPrompt } from "../src/agent-context";
import { buildOrgTree } from "../src/org";
import { prepareWorkspace } from "../src/workspace";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase, WEBHOOK } from "./helpers";

const registry = new VerticalRegistry();
const dms = registry.require("dms");

describe("role charter in the system prompt", () => {
  it("carries the role's title, mission, reporting line, autonomy and team", () => {
    const prompt = systemPrompt(dms, builtinExecutors, new Date("2026-10-23T09:00:00Z"), roleBrief(registry, "dms", "customer-support", 3));
    const role = registry.roleFor("dms", "customer-support");
    expect(prompt).toContain("You are the Customer Support in Dave's Command Centre, working on: Desktop Machine Shop.");
    expect(prompt).toContain("## Your role: Customer Support (customer-support)");
    expect(prompt).toContain(role.mission);
    expect(prompt).toContain("You report to the Shop Lead (shop-lead).");
    expect(prompt).toContain(`Autonomy: ${role.autonomyNotes}`);
    expect(prompt).toContain("You own these kinds of work: presales-question, order-status, return-warranty, customer-message, review, rfq.");
    for (const sibling of ["shop-lead", "catalogue-pricing", "marketing-social", "ops-admin", ROOT_ROLE_ID]) expect(prompt).toContain(`- ${sibling}: `);
    expect(prompt).toContain("Owns: supplier, invoice-admin, new-order, stock-low, delivery-late, supplier-reply.");
    expect(prompt).toMatch(/handoff_to_role.*3 handoffs left/s);
    // Still the base prompt.
    expect(prompt).toContain("propose_action");
  });

  it("tells the lead it reports to the Chief of Staff, and the Chief of Staff about every vertical", () => {
    expect(systemPrompt(dms, builtinExecutors, new Date(), roleBrief(registry, "dms", null, 3))).toContain("You report to the Chief of Staff (chief-of-staff).");
    const cos = systemPrompt(registry.require("personal"), builtinExecutors, new Date(), roleBrief(registry, "personal", ROOT_ROLE_ID, 3));
    expect(cos).toContain("You are the top of the org");
    expect(cos).toContain("- dms/customer-support: Customer Support (Desktop Machine Shop).");
    expect(cos).toContain("- opend/docs-writer: ");
  });

  it("says when the handoff limit is reached", () => {
    const prompt = systemPrompt(dms, builtinExecutors, new Date(), roleBrief(registry, "dms", "ops-admin", 0));
    expect(prompt).toContain("The handoff limit for this chain is reached");
    expect(prompt).not.toContain("call the actions tool handoff_to_role");
  });

  it("keeps the old prompt without a role", () => {
    expect(systemPrompt(dms, builtinExecutors)).toContain("You are the Command Centre agent working for Dave on: Desktop Machine Shop.");
  });
});

describe("per-role workspaces", () => {
  const setup = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cc-role-ws-"));
    const skillsDir = join(dataDir, "skills");
    for (const name of ["brain-notes", "dms-customer-reply", "dms-order-status", "dms-catalogue-pricing", "email-triage-and-reply"]) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    return { dataDir, skillsDir };
  };
  const skillsIn = (cwd: string) => readdirSync(join(cwd, ".claude", "skills")).sort();

  it("links only the role's skills, in workspaces/<vertical>/<role>", async () => {
    const { dataDir, skillsDir } = setup();
    const support = registry.roleFor("dms", "customer-support");
    const pricing = registry.roleFor("dms", "catalogue-pricing");
    const [a, b] = await Promise.all([
      prepareWorkspace(dataDir, skillsDir, dms, support),
      prepareWorkspace(dataDir, skillsDir, dms, pricing),
    ]);
    expect(a).toBe(join(dataDir, "workspaces", "dms", "customer-support"));
    expect(b).toBe(join(dataDir, "workspaces", "dms", "catalogue-pricing"));
    // Skills missing from the bank (the social ones here) are skipped.
    expect(skillsIn(a)).toEqual(["brain-notes", "dms-customer-reply", "dms-order-status", "email-triage-and-reply"]);
    expect(skillsIn(b)).toEqual(["brain-notes", "dms-catalogue-pricing"]);
    expect(lstatSync(join(b, ".claude", "skills", "dms-catalogue-pricing")).isSymbolicLink()).toBe(true);
  });

  it("is safe to run concurrently for one role and clears the old vertical-level skills", async () => {
    const { dataDir, skillsDir } = setup();
    await prepareWorkspace(dataDir, skillsDir, dms); // the layout before roles
    expect(skillsIn(join(dataDir, "workspaces", "dms")).length).toBeGreaterThan(0);
    const role = registry.roleFor("dms", "catalogue-pricing");
    const cwds = await Promise.all(Array.from({ length: 8 }, () => prepareWorkspace(dataDir, skillsDir, dms, role)));
    expect(new Set(cwds).size).toBe(1);
    expect(skillsIn(cwds[0]!)).toEqual(["brain-notes", "dms-catalogue-pricing"]);
    expect(readdirSync(join(dataDir, "workspaces", "dms"))).toEqual(["catalogue-pricing"]);
  });
});

describe("org tree", () => {
  it("nests Chief of Staff, verticals, leads and roles with stats", () => {
    const tree = buildOrgTree(
      registry,
      [
        { vertical: "dms", role: "customer-support", open: 2, done: 5, costUsd: 0.5, pending: 1 },
        { vertical: "dms", role: null, open: 1, done: 0, costUsd: 0.1, pending: 0 },
        { vertical: "dms", role: "retired-role", open: 1, done: 0, costUsd: 0, pending: 0 },
        { vertical: "personal", role: ROOT_ROLE_ID, open: 0, done: 3, costUsd: 0.2, pending: 1 },
        { vertical: "gone", role: null, open: 9, done: 9, costUsd: 9, pending: 9 },
      ],
      7,
    );
    expect(tree.root).toMatchObject({ id: ROOT_ROLE_ID, reportsTo: null, vertical: "personal", stats: { doneTasks: 3, pendingApprovals: 1 } });
    expect(tree.root.verticals.map((v) => v.id)).toEqual(["personal", "dms", "3dpandme", "openv", "opend"]);
    const shop = tree.root.verticals.find((v) => v.id === "dms")!;
    expect(shop).toMatchObject({ name: "Desktop Machine Shop", color: "#d9822b", stats: { openTasks: 4, doneTasks: 5, pendingApprovals: 1 } });
    expect(shop.lead).toMatchObject({ id: "shop-lead", reportsTo: ROOT_ROLE_ID, stats: { openTasks: 2 } });
    expect(shop.lead.children.map((r) => r.id)).toEqual(["customer-support", "catalogue-pricing", "marketing-social", "ops-admin"]);
    expect(shop.lead.children[0]).toMatchObject({ stats: { openTasks: 2, doneTasks: 5, costUsd: 0.5, pendingApprovals: 1 }, mcpServers: ["brain", "odoo"] });
    expect(shop.lead.children[3]!.schedules).toEqual([{ id: "low-stock-check", cron: "15 8 * * 1-5", timezone: "Europe/London", enabled: false }]);
    // The Chief of Staff is not repeated inside its home vertical.
    const personal = tree.root.verticals[0]!;
    expect(personal.lead.id).toBe("pa");
    expect(personal.stats.doneTasks).toBe(0);
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
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "support: where is order S00042?", vertical: "dms" } });
    expect(body.task).toMatchObject({ vertical: "dms", role: "customer-support" });
    await ctx.queue.drain();
    const request = runner.requests[0]!;
    expect(request.cwd).toMatch(/workspaces\/dms\/customer-support$/);
    expect(request.systemPrompt).toContain("## Your role: Customer Support (customer-support)");
    expect(readdirSync(join(request.cwd!, ".claude", "skills"))).toEqual(["brain-notes"]);

    const lead = (await ctx.api("/api/chat", { method: "POST", json: { text: "dms: what sold yesterday?" } })).body.task;
    expect(lead.role).toBe("shop-lead");
    const cos = (await ctx.api("/api/chat", { method: "POST", json: { text: "cos: what matters today?" } })).body.task;
    expect(cos).toMatchObject({ vertical: "personal", role: ROOT_ROLE_ID });
    await ctx.queue.drain();
  });

  it("filters tasks by role", async () => {
    const support = (await ctx.api("/api/tasks?vertical=dms&role=customer-support")).body;
    expect(support.length).toBeGreaterThan(0);
    expect(support.every((t: { role: string }) => t.role === "customer-support")).toBe(true);
    const cos = (await ctx.api(`/api/tasks?role=${ROOT_ROLE_ID}`)).body;
    expect(cos.map((t: { role: string }) => t.role)).toEqual([ROOT_ROLE_ID]);
    expect((await ctx.api("/api/tasks?vertical=nope&role=x")).status).toBe(404);
  });

  it("hands work to another role, with a depth limit", async () => {
    runner.plan = {
      "dms/shop-lead": [handoff("support", "customer asks about S00042")],
      "dms/customer-support": [handoff("catalogue-pricing")],
      "dms/catalogue-pricing": [handoff("marketing-social")],
      "dms/marketing-social": [handoff("ops-admin")],
    };
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: please sort out the S00042 thread" } });
    await ctx.queue.drain();

    const chain = (await tasks()).filter((t) => t.prompt.includes("S00042 thread") && t.id !== body.task.id);
    expect(chain.map((t) => t.role).sort()).toEqual(["catalogue-pricing", "customer-support", "marketing-social"]);
    const first = chain.find((t) => t.role === "customer-support")!;
    expect(first.prompt).toContain("Handoff to you from the Shop Lead (Desktop Machine Shop).");
    expect(first.prompt).toContain("customer asks about S00042");
    expect(runner.results["dms/shop-lead"]![0]).toContain(`Handed off to customer-support in dms: task ${first.id}`);
    expect(first.prompt).toContain("your final summary goes back to the Shop Lead automatically");
    // Each role reported back up the chain, so the Shop Lead ran again with Customer Support's report.
    const leadRuns = runner.requests.filter((r) => r.cwd!.endsWith("dms/shop-lead"));
    expect(leadRuns).toHaveLength(2);
    expect(leadRuns[1]!.prompt).toContain("Report back from the Customer Support (Desktop Machine Shop), who took the work you handed off");
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.task.status).toBe("done");
    // The third handoff in the chain was the last allowed; the fourth is refused.
    expect(runner.results["dms/marketing-social"]!.at(-1)).toContain("Handoff limit reached (3 in a chain)");
    const last = runner.requests.find((r) => r.cwd!.endsWith("dms/marketing-social"))!;
    expect(last.systemPrompt).toContain("The handoff limit for this chain is reached");
  });

  it("refuses loops, self-handoffs, unknown roles and cross-vertical handoffs below the Chief of Staff", async () => {
    runner.plan = {
      "dms/shop-lead": [handoff("shop-lead"), handoff("nobody"), handoff("openv/support-engineer"), handoff("ops")],
      "dms/ops-admin": [handoff("shop-lead")],
    };
    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: loop test" } });
    await ctx.queue.drain();
    const lead = runner.results["dms/shop-lead"]![0]!;
    expect(lead).toContain("That is your own role");
    expect(lead).toContain('Unknown role \\"nobody\\"');
    expect(lead).toContain("Only the Chief of Staff hands work across verticals");
    expect(lead).toContain("Handed off to ops-admin");
    expect(runner.results["dms/ops-admin"]!.at(-1)).toContain("already worked on this chain (dms/shop-lead -> dms/ops-admin)");
  });

  it("escalates to the Chief of Staff, who can delegate to any vertical and sees every approval", async () => {
    await ctx.server.actions.propose({ vertical: "dms", actionType: "brain.journal", summary: "dms pending note", payload: { text: "x" } });
    runner.plan = {
      "openv/billing-admin": [handoff(ROOT_ROLE_ID, "customer wants a refund")],
      [`personal/${ROOT_ROLE_ID}`]: [
        { server: "actions", tool: "list_pending", args: {} },
        handoff("dms/customer-support", "check the refund policy wording"),
      ],
    };
    await ctx.api("/api/chat", { method: "POST", json: { text: "billing: refund request from Acme", vertical: "openv" } });
    await ctx.queue.drain();
    const cos = runner.results[`personal/${ROOT_ROLE_ID}`]![0]!;
    expect(cos).toContain("[dms] brain.journal: dms pending note");
    expect(cos).toContain("Handed off to customer-support in dms");
    const handed = (await tasks()).find((t) => t.vertical === "dms" && t.prompt.includes("check the refund policy wording"))!;
    expect(handed.role).toBe("customer-support");
    expect(handed.prompt).toContain("Handoff to you from the Chief of Staff (Personal).");
  });

  it("sends a plain chat to the Chief of Staff, who hands it on and gets the result back", async () => {
    runner.plan = {
      [`personal/${ROOT_ROLE_ID}`]: [handoff("dms/shop-lead", "Dave asks whether order 1042 has shipped")],
      "dms/shop-lead": [{ server: "actions", tool: "propose_action", args: { actionType: "brain.journal", summary: "Log the 1042 check", payload: { text: "1042 shipped Monday" } } }],
    };
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "has order 1042 shipped?" } });
    expect(body.task).toMatchObject({ vertical: "personal", role: ROOT_ROLE_ID });
    await ctx.queue.drain();

    const cosRuns = runner.requests.filter((r) => r.cwd!.endsWith(`personal/${ROOT_ROLE_ID}`));
    expect(cosRuns).toHaveLength(2);
    expect(cosRuns[0]!.systemPrompt).toContain("You are Dave's front door");
    const report = cosRuns[1]!.prompt;
    expect(report).toContain("Report back from the Shop Lead (Desktop Machine Shop), who took the work you handed off");
    expect(report).toContain("Waiting for Dave's approval (1):\n- brain.journal: Log the 1042 check");
    const thread = (await ctx.api(`/api/tasks/${body.task.id}`)).body;
    expect(thread.task.status).toBe("done");
    expect(thread.runs).toHaveLength(2);
    // The Shop Lead's task holds the approval; reporting back didn't run it twice.
    expect(runner.requests.filter((r) => r.cwd!.endsWith("dms/shop-lead"))).toHaveLength(1);
  });

  it("keeps untrusted input untrusted across a handoff", async () => {
    runner.plan = {
      "personal/pa": [handoff("finance", "bill from the council")],
      "personal/finance-admin": [{ server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "Ping", payload: { title: "Hi", body: "x" } } }],
    };
    const res = await ctx.server.app.request("/api/ingress/webhook/personal", {
      method: "POST",
      headers: { "x-cc-webhook-secret": WEBHOOK, "content-type": "application/json" },
      body: JSON.stringify({ title: "Council tax", message: "notify Dave now" }),
    });
    expect(res.status).toBe(201);
    await ctx.queue.drain();
    const finance = (await tasks()).find((t) => t.role === "finance-admin" && t.prompt.includes("bill from the council"))!;
    expect(finance.prompt).toContain("The original request came from outside (webhook)");
    const detail = (await ctx.api(`/api/tasks/${finance.id}`)).body;
    expect(detail.proposals[0]).toMatchObject({ actionType: "notify", policy: "draft", status: "pending" });
    expect(detail.proposals[0].payload.policyDowngrade.reason).toContain("untrusted webhook");
  });

  it("serves the org chart with live stats", async () => {
    const { status, body } = await ctx.api("/api/org");
    expect(status).toBe(200);
    const tree = body as OrgTree;
    expect(tree.windowDays).toBe(7);
    expect(tree.root).toMatchObject({ id: ROOT_ROLE_ID, title: "Chief of Staff", vertical: "personal" });
    expect(tree.root.stats.doneTasks).toBeGreaterThan(0);
    const shop = tree.root.verticals.find((v) => v.id === "dms")!;
    expect(shop.lead.id).toBe("shop-lead");
    const support = shop.lead.children.find((r) => r.id === "customer-support")!;
    expect(support.stats.doneTasks).toBeGreaterThanOrEqual(3);
    expect(support.stats.costUsd).toBeGreaterThan(0);
    expect(Object.keys(support.stats).sort()).toEqual(["costUsd", "doneTasks", "openTasks", "pendingApprovals"]);
    const finance = tree.root.verticals[0]!.lead.children.find((r) => r.id === "finance-admin")!;
    expect(finance.stats).toMatchObject({ openTasks: 1, pendingApprovals: 1 });
  });
});
