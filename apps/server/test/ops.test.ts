import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Pool } from "../src/db/pool";
import { formatLogLine, performanceReport, ServerLog, serverLogReport } from "../src/ops";
import { DB_URL, resetDatabase } from "./helpers";

describe("formatLogLine", () => {
  it("prints arguments like the console, clipped", () => {
    expect(formatLogLine(["[odoo]", "poll failed:", { code: 504 }])).toBe("[odoo] poll failed: { code: 504 }");
    expect(formatLogLine([new Error("boom")])).toContain("Error: boom");
    expect(formatLogLine(["x".repeat(5000)]).length).toBe(2001);
  });
});

describe.skipIf(!DB_URL)("ops: run performance and the server log (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    pool = createPool(DB_URL!);
    await migrate(pool);
  });
  afterAll(async () => pool?.end());

  const task = async (o: { role: string; status: string; prompt: string; updatedAgo?: string }) => {
    const event = randomUUID();
    const id = randomUUID();
    await pool.query("insert into events (id, source, vertical, kind, title) values ($1, 'chat', 'command-centre', 'chat', 't')", [event]);
    await pool.query(
      `insert into tasks (id, event_id, vertical, intent, route, urgency, status, prompt, triage, role, updated_at)
       values ($1, $2, 'command-centre', 'software', 'agent', 0.5, $3, $4, '{}', $5, now() - $6::interval)`,
      [id, event, o.status, o.prompt, o.role, o.updatedAgo ?? "0 seconds"],
    );
    return id;
  };
  const run = (taskId: string, o: { status: string; seconds: number; cost: number; error?: string }) =>
    pool.query(
      `insert into agent_runs (id, task_id, runner, status, error, cost_usd, started_at, finished_at)
       values ($1, $2, 'test', $3, $4, $5, now() - make_interval(secs => $6), now())`,
      [randomUUID(), taskId, o.status, o.error ?? null, o.cost, o.seconds],
    );

  it("reports runs, failures, cost, slow and costly runs, actions and stuck tasks", async () => {
    const ok = await task({ role: "software-lead", status: "done", prompt: "Fix the digest" });
    await run(ok, { status: "succeeded", seconds: 600, cost: 2.5 });
    const bad = await task({ role: "software-lead", status: "failed", prompt: "Merge PR 11" });
    await run(bad, { status: "failed", seconds: 30, cost: 0.1, error: "GitHub refused the pull request" });
    await task({ role: "pa", status: "running", prompt: "Stuck one", updatedAgo: "3 hours" });
    await pool.query(
      `insert into proposals (id, task_id, vertical, action_type, summary, policy, status, result) values
       ($1, $2, 'command-centre', 'github.issue.create', 'Issue: x', 'auto', 'failed', '{"ok":false,"error":"403"}'),
       ($3, $2, 'command-centre', 'github.issue.create', 'Issue: y', 'auto', 'executed', null)`,
      [randomUUID(), bad, randomUUID()],
    );

    const r = await performanceReport(pool, 1);
    expect(r.totals).toEqual({ runs: 2, failed: 1, costUsd: 2.6 });
    expect(r.byRole).toEqual([expect.objectContaining({ vertical: "command-centre", role: "software-lead", runs: 2, failed: 1, cost_usd: 2.6, max_seconds: 600 })]);
    expect(r.failedRuns).toEqual([expect.objectContaining({ prompt: "Merge PR 11", error: "GitHub refused the pull request" })]);
    expect(r.slowestRuns[0]).toMatchObject({ prompt: "Fix the digest", seconds: 600 });
    expect(r.costliestRuns[0]).toMatchObject({ prompt: "Fix the digest", cost_usd: 2.5 });
    expect(r.actions).toEqual([{ action_type: "github.issue.create", proposed: 2, failed: 1, rejected: 0, pending: 0 }]);
    expect(r.failedActions[0]).toMatchObject({ summary: "Issue: x", result: '{"ok": false, "error": "403"}' });
    expect(r.stuckTasks).toEqual([expect.objectContaining({ prompt: "Stuck one", status: "running" })]);
  });

  it("records console warnings and errors, and groups repeats", async () => {
    const printed: string[] = [];
    const fake = { warn: (...a: unknown[]) => printed.push(`W ${a.join(" ")}`), error: (...a: unknown[]) => printed.push(`E ${a.join(" ")}`) };
    const log = new ServerLog(pool, { flushMs: 60_000 });
    log.install(fake);
    fake.error("[odoo] poll 1 failed: timeout");
    fake.error("[odoo] poll 2 failed: timeout");
    fake.warn("[help] no docs");
    await log.uninstall(); // flushes
    expect(printed).toEqual(["E [odoo] poll 1 failed: timeout", "E [odoo] poll 2 failed: timeout", "W [help] no docs"]);
    fake.error("after uninstall"); // printed by the original only, not recorded
    await log.flush();

    const all = await serverLogReport(pool, { days: 1, limit: 10 });
    expect(all.lines).toBe(3);
    expect(all.groups).toEqual([
      expect.objectContaining({ level: "error", count: 2, example: expect.stringMatching(/\[odoo\] poll \d failed/) }),
      expect.objectContaining({ level: "warn", count: 1, example: "[help] no docs" }),
    ]);
    expect((await serverLogReport(pool, { days: 1, level: "warn", limit: 10 })).lines).toBe(1);
    expect((await serverLogReport(pool, { days: 1, contains: "[ODOO", limit: 10 })).lines).toBe(2);
  });
});
