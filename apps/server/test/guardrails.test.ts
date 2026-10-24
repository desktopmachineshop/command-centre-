import type { AgentRunner, AgentRunRequest, AgentRunResult } from "@cc/agent-runtime";
import { defineVertical } from "@cc/core";
import { chiefOfStaff, VerticalRegistry, verticals } from "@cc/verticals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, DB_URL, makeServer, McpCallingRunner, resetDatabase, WEBHOOK } from "./helpers";

type McpCall = { server: string; tool: string; args: Record<string, unknown> };
type Step = { cost?: number; fail?: boolean; calls?: McpCall[] };

/** A runner whose cost, outcome and timing the test controls, and which records concurrency per vertical. */
class ControlledRunner implements AgentRunner {
  readonly name = "controlled";
  app?: McpCallingRunner["app"];
  defaultCost = 0;
  readonly steps: Step[] = [];
  readonly prompts: string[] = [];
  /** While set, every run waits for it. */
  gate: Promise<void> | null = null;
  private readonly active = new Map<string, number>();
  readonly maxActive = new Map<string, number>();
  maxTotal = 0;

  get running() {
    return [...this.active.values()].reduce((a, b) => a + b, 0);
  }

  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise((r) => (release = r));
    return () => {
      this.gate = null;
      release();
    };
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const vertical = request.cwd!.split("/").at(-2)!; // workspaces/<vertical>/<role>
    const step = this.steps.shift() ?? {};
    this.prompts.push(request.prompt);
    this.active.set(vertical, (this.active.get(vertical) ?? 0) + 1);
    this.maxActive.set(vertical, Math.max(this.maxActive.get(vertical) ?? 0, this.active.get(vertical)!));
    this.maxTotal = Math.max(this.maxTotal, this.running);
    try {
      if (this.gate) await this.gate;
      if (step.calls?.length) {
        const mcp = new McpCallingRunner(step.calls);
        mcp.app = this.app;
        await mcp.run(request);
      }
      const costUsd = step.cost ?? this.defaultCost;
      return step.fail
        ? { status: "failed", result: null, error: "boom", costUsd, sessionId: null }
        : { status: "succeeded", result: "ok", error: null, costUsd, sessionId: null };
    } finally {
      this.active.set(vertical, this.active.get(vertical)! - 1);
    }
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function truncate(ctx: Awaited<ReturnType<typeof makeServer>>) {
  await ctx.server.store.pool.query("truncate events, tasks, agent_runs, run_messages, proposals, budget_alerts, jobs cascade");
}

/** Registry where dms has a $1/day budget. */
const budgeted = () => new VerticalRegistry(verticals.map((v) => (v.id === "dms" ? defineVertical({ ...v, dailyBudgetUsd: 1 }) : v)));

describe.skipIf(!DB_URL)("budgets, retry and rollover", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new ControlledRunner();

  const webhook = async (vertical: string, title: string) => {
    const res = await ctx.server.app.request(`/api/ingress/webhook/${vertical}`, {
      method: "POST",
      headers: { "x-cc-webhook-secret": WEBHOOK, "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const body = (await res.json()) as { task: { id: string } };
    await ctx.queue.drain();
    return (await ctx.api(`/api/tasks/${body.task.id}`)).body.task;
  };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({
      runner,
      verticals: budgeted(),
      env: { AGENT_DAILY_BUDGET_USD: "3", AGENT_BUSY_RETRY_SECONDS: "0.05" },
    });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(async () => {
    await truncate(ctx);
    ctx.notifier.sent.length = 0;
    runner.defaultCost = 0.6;
  });

  it("defers work over a vertical's budget and notifies once per day", async () => {
    expect((await webhook("dms", "Order 1")).status).toBe("done");
    expect((await webhook("dms", "Order 2")).status).toBe("done"); // $0.60 < $1 when it started

    const third = await webhook("dms", "Order 3");
    expect(third.status).toBe("deferred");
    expect(third.note).toMatch(/Desktop Machine Shop daily budget reached \(\$1\.20 of \$1\.00\)/);
    const fourth = await webhook("dms", "Order 4");
    expect(fourth.status).toBe("deferred");

    const alerts = ctx.notifier.sent.filter((n) => n.title.startsWith("Budget reached"));
    expect(alerts).toEqual([expect.objectContaining({ title: "Budget reached: Desktop Machine Shop" })]);
    // Other verticals keep running.
    expect((await webhook("opend", "Signup")).status).toBe("done");

    const stats = (await ctx.api("/api/stats")).body;
    expect(stats.costTodayByVertical).toEqual({ dms: 1.2, opend: 0.6 });
    expect(stats.costTodayUsd).toBeCloseTo(1.8);
    expect(stats.budgets).toEqual({ globalUsd: 3, verticals: { dms: 1 } });
    expect((await ctx.api("/api/tasks?status=deferred")).body).toHaveLength(2);
  });

  it("lets Dave's chat requests bypass the budget", async () => {
    runner.defaultCost = 1.5;
    await webhook("dms", "Order 1");
    expect((await webhook("dms", "Order 2")).status).toBe("deferred");

    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: check stock now" } });
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${body.task.id}`)).body.task.status).toBe("done");
  });

  it("applies the global budget across verticals", async () => {
    runner.defaultCost = 1.6;
    await webhook("opend", "Signup 1");
    await webhook("openv", "Signup 2");
    const blocked = await webhook("personal", "Reminder");
    expect(blocked.status).toBe("deferred");
    expect(blocked.note).toMatch(/^Daily budget reached \(\$3\.20 of \$3\.00\)/);
    expect(ctx.notifier.sent.map((n) => n.title)).toContain("Budget reached: all verticals");
  });

  it("retries failed tasks", async () => {
    runner.steps.push({ fail: true });
    const failed = await webhook("opend", "Broken");
    expect(failed.status).toBe("failed");
    await ctx.api(`/api/tasks/${failed.id}/retry`, { method: "POST" });
    await ctx.queue.drain();
    const detail = (await ctx.api(`/api/tasks/${failed.id}`)).body;
    expect(detail.task.status).toBe("done");
    expect(detail.runs.map((r: { status: string }) => r.status)).toEqual(["failed", "succeeded"]);

    expect((await ctx.api(`/api/tasks/${failed.id}/retry`, { method: "POST" })).status).toBe(409);
    expect((await ctx.api(`/api/tasks/00000000-0000-0000-0000-000000000000/retry`, { method: "POST" })).status).toBe(404);
  });

  it("retries a deferred task past the budget, once", async () => {
    runner.defaultCost = 1.5;
    await webhook("dms", "Order 1");
    const deferred = await webhook("dms", "Order 2");
    expect(deferred.status).toBe("deferred");

    const retried = await ctx.api(`/api/tasks/${deferred.id}/retry`, { method: "POST" });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: "queued", note: null });
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${deferred.id}`)).body.task.status).toBe("done");
    // Only once: the next task is deferred again.
    expect((await webhook("dms", "Order 3")).status).toBe("deferred");
  });

  it("re-queues deferred tasks when the day rolls over", async () => {
    runner.defaultCost = 1.5;
    await webhook("dms", "Order 1");
    const a = await webhook("dms", "Order 2");
    const b = await webhook("dms", "Order 3");
    expect([a.status, b.status]).toEqual(["deferred", "deferred"]);
    const alerts = () => ctx.notifier.sent.filter((n) => n.title.startsWith("Budget reached")).length;
    expect(alerts()).toBe(1);

    // Still the same day: the sweep re-defers them, without another push.
    await ctx.server.pipeline.releaseDeferred();
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${a.id}`)).body.task.status).toBe("deferred");
    expect(alerts()).toBe(1);

    // Next day: yesterday's spend no longer counts.
    await ctx.server.store.pool.query("update agent_runs set started_at = started_at - interval '2 days'");
    runner.defaultCost = 0.1;
    await ctx.server.rollover();
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${a.id}`)).body.task.status).toBe("done");
    expect((await ctx.api(`/api/tasks/${b.id}`)).body.task.status).toBe("done");
  });
});

describe.skipIf(!DB_URL)("concurrency per vertical and dedupe", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new ControlledRunner();
  const statusOf = async (id: string) => (await ctx.api(`/api/tasks/${id}`)).body.task.status as string;
  const chat = async (text: string) => (await ctx.api("/api/chat", { method: "POST", json: { text } })).body.task;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner, env: { AGENT_BUSY_RETRY_SECONDS: "0.05" } });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(async () => truncate(ctx));

  it("runs one task per vertical at a time without blocking other verticals", async () => {
    const release = runner.hold();
    const first = await chat("dms: count the spindles");
    const second = await chat("dms: count the collets");
    const other = await chat("plan my week");
    await until(() => runner.running === 2);
    // Give the waiting dms task a few requeue cycles to prove it stays queued.
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.running).toBe(2);
    expect(await statusOf(first.id)).toBe("running");
    expect(await statusOf(second.id)).toBe("queued");
    expect(await statusOf(other.id)).toBe("running");

    release();
    await ctx.queue.drain();
    expect([await statusOf(first.id), await statusOf(second.id), await statusOf(other.id)]).toEqual(["done", "done", "done"]);
    expect(runner.maxActive.get("dms")).toBe(1);
    expect(runner.maxTotal).toBe(2);
  });

  it("does not let a crashed run hold its vertical's slot forever", async () => {
    const stuck = await chat("dms: stuck task");
    await ctx.queue.drain();
    // Pretend a previous process died mid-run long ago.
    await ctx.server.store.pool.query("update tasks set status = 'running', updated_at = now() - interval '2 hours' where id = $1", [stuck.id]);
    const next = await chat("dms: next task");
    await ctx.queue.drain();
    expect(await statusOf(next.id)).toBe("done");
  });

  it("links an identical in-flight request instead of running it again", async () => {
    const release = runner.hold();
    const original = await chat("dms: reprice the ER11 collets");
    await until(() => runner.running === 1);
    const repeat = await chat("dms: reprice the ER11 collets");
    expect(repeat).toMatchObject({ status: "dropped", duplicateOf: original.id });
    expect(repeat.note).toMatch(/already running/);
    // Same words in another vertical are different work.
    const elsewhere = await chat("reprice the ER11 collets");
    expect(elsewhere.status).toBe("queued");

    release();
    await ctx.queue.drain();
    expect(runner.prompts.filter((p) => p === "dms: reprice the ER11 collets")).toHaveLength(1);
    // Once the first one finished, the same request runs again.
    expect((await chat("dms: reprice the ER11 collets")).status).toBe("queued");
    await ctx.queue.drain();
  });
});

describe.skipIf(!DB_URL)("daily digest", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new ControlledRunner();

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());

  it("summarises the day without an agent run, as a brain note and a push", async () => {
    runner.steps.push(
      { cost: 0.25 },
      { cost: 0.1, fail: true },
      {
        cost: 0.05,
        calls: [
          { server: "actions", tool: "propose_action", args: { actionType: "notify", summary: "Remind Dave", payload: { title: "Hi", body: "Bins" } } },
          { server: "actions", tool: "propose_action", args: { actionType: "brain.journal", summary: "Log the bins", payload: { text: "Bins out" } } },
        ],
      },
    );
    for (const text of ["plan the garden", "book the dentist", "remind me about the bins"]) {
      await ctx.api("/api/chat", { method: "POST", json: { text } });
      await ctx.queue.drain();
    }
    const job = await ctx.server.store.insertJob({ kind: "render", requires: [], payload: { vertical: "personal" } });
    await ctx.server.store.pool.query("update jobs set status = 'succeeded' where id = $1", [job.id]);
    const runsBefore = (await ctx.server.store.pool.query("select count(*)::int as n from agent_runs")).rows[0].n;

    const { body } = await ctx.api("/api/digest?vertical=personal");
    expect(body.digests).toHaveLength(1);
    const d = body.digests[0];
    expect(d).toMatchObject({
      vertical: "personal",
      date: ctx.server.digests.today(),
      counts: { done: 1, failed: 1, deferred: 0, autoActions: 1, pendingApprovals: 1, jobs: 1 },
    });
    expect(d.costUsd).toBeCloseTo(0.4);
    expect(d.done[0].title).toBe("plan the garden");
    expect(d.autoActions[0]).toMatchObject({ actionType: "notify", summary: "Remind Dave", status: "executed" });
    expect(d.pendingApprovals[0]).toMatchObject({ actionType: "brain.journal" });
    expect(d.headline).toBe("Personal: 1 done, 1 failed, 1 auto, 1 to approve, 1 jobs, $0.40");
    expect(body.totals).toMatchObject({ done: 1, failed: 1, pendingApprovals: 1 });

    ctx.notifier.sent.length = 0;
    await ctx.server.digests.deliver();
    const note = await ctx.server.brain.read(`personal/digests/${d.date}.md`);
    expect(note?.frontmatter).toMatchObject({ type: "digest", vertical: "personal", date: d.date });
    expect(note?.body).toContain("## Auto actions (auto-with-digest)");
    expect(note?.body).toContain("executed: notify: Remind Dave");
    expect(note?.body).toContain("## Failed");
    expect(note?.body).toContain("brain.journal: Log the bins");
    // Quiet verticals get no note.
    expect(await ctx.server.brain.read(`openv/digests/${d.date}.md`)).toBeNull();
    expect(ctx.notifier.sent).toEqual([expect.objectContaining({ title: `Daily digest, ${d.date}`, body: d.headline })]);

    const runsAfter = (await ctx.server.store.pool.query("select count(*)::int as n from agent_runs")).rows[0].n;
    expect(runsAfter).toBe(runsBefore);
  });

  it("lets agents list pending approvals for the brief", async () => {
    const agent = new McpCallingRunner([{ server: "actions", tool: "list_pending", args: {} }]);
    agent.app = ctx.server.app;
    const headers = { Authorization: `Bearer ${ADMIN}` };
    const { result } = await agent.run({ prompt: "", mcpServers: { actions: { type: "http", url: "http://cc.test/mcp/actions", headers } } });
    expect(result).toContain("[personal] brain.journal: Log the bins");
  });

  it("serves other dates and validates input", async () => {
    const quiet = (await ctx.api("/api/digest?date=2020-01-01&vertical=dms")).body.digests[0];
    expect(quiet.counts).toMatchObject({ done: 0, failed: 0, autoActions: 0 });
    expect((await ctx.api("/api/digest?date=yesterday")).status).toBe(400);
    expect((await ctx.api("/api/digest?vertical=nope")).status).toBe(404);
    expect((await ctx.api("/api/digest")).body.digests.map((d: { vertical: string }) => d.vertical)).toEqual(
      verticals.map((v) => v.id),
    );
  });

  it("offers a morning brief, owned by the Chief of Staff and off by default", () => {
    expect(chiefOfStaff.homeVertical).toBe("personal");
    const brief = chiefOfStaff.schedules.find((s) => s.id === "morning-brief");
    expect(brief).toMatchObject({ cron: "0 7 * * 1-5", timezone: "Europe/London", enabled: false });
    expect(brief!.prompt).toMatch(/digests/);
    expect(brief!.prompt).toMatch(/list_pending/);
    expect(brief!.prompt).toMatch(/"notify"/);
  });
});
