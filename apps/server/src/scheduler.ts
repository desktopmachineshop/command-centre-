import { type NewEvent, type Schedule, schedulesOf, type VerticalManifest } from "@cc/core";
import { Cron } from "croner";

/**
 * Turns every enabled schedule into cron events: the vertical's own, its roles'
 * and the org root's (`root`, run in its home vertical). A role schedule's event
 * carries `payload.role`, so its task goes to that role. The dedupe key is per
 * minute, so several server replicas firing together create one event.
 */
export function startSchedules(
  verticals: VerticalManifest[],
  ingest: (e: NewEvent) => Promise<unknown>,
  root?: { vertical: string; role: string; schedules: Schedule[] },
  /** Asked at each firing; false skips it (the competitor watch with nobody to watch, ./competitors.ts). */
  shouldFire?: (vertical: VerticalManifest, schedule: Schedule) => Promise<boolean>,
): Cron[] {
  const entries = verticals.flatMap((v) => schedulesOf(v).map((s) => ({ vertical: v, ...s })));
  const home = root && verticals.find((v) => v.id === root.vertical);
  if (root && home) entries.push(...root.schedules.map((schedule) => ({ vertical: home, schedule, role: root.role })));

  const jobs: Cron[] = [];
  for (const { vertical, schedule, role } of entries) {
    if (!schedule.enabled) continue;
    jobs.push(
      new Cron(schedule.cron, { timezone: schedule.timezone, protect: true }, async () => {
        const minute = new Date().toISOString().slice(0, 16);
        if (shouldFire && !(await shouldFire(vertical, schedule).catch(() => true))) return;
        await ingest({
          source: "cron",
          vertical: vertical.id,
          kind: `schedule:${schedule.id}`,
          title: `Scheduled: ${vertical.name} / ${schedule.id}`,
          payload: { prompt: schedule.prompt, scheduleId: schedule.id, ...(role ? { role } : {}) },
          dedupeKey: `cron:${vertical.id}:${schedule.id}:${minute}`,
        }).catch((err) => console.error(`[schedule ${vertical.id}/${schedule.id}]`, err));
      }),
    );
  }
  return jobs;
}

/**
 * Built-in jobs that are not agent runs: the daily digest (`digestCron`) and
 * the weekly low-stock summary (`lowStockCron`), each off when unset; the budget-day rollover just after local midnight, and, when
 * social accounts are configured, publishing due scheduled posts every minute.
 */
export function startSystemJobs(options: {
  timezone: string;
  digestCron?: string;
  digest: () => Promise<unknown>;
  /** The weekly low-stock summary (off when unset). */
  lowStockCron?: string;
  lowStock?: () => Promise<unknown>;
  rollover: () => Promise<unknown>;
  socialPublish?: () => Promise<unknown>;
  /** Delivers due PA reminders as pushes, every minute. */
  paReminders?: () => Promise<unknown>;
  /** Renews expiring Accounts-page sign-ins (Instagram, Threads), daily. */
  integrationsRefresh?: () => Promise<unknown>;
  /** Deletes old renders on the volume and warns when it's nearly full, nightly. */
  storageHousekeeping?: () => Promise<unknown>;
  /** Moves issue notes written outside the brain's issues/ folder into it, daily. */
  issuesAudit?: () => Promise<unknown>;
}): Cron[] {
  const job = (name: string, cron: string, fn: () => Promise<unknown>) =>
    new Cron(cron, { timezone: options.timezone, protect: true }, async () => {
      await fn().catch((err) => console.error(`[${name}]`, err));
    });
  const jobs = [job("rollover", "1 0 * * *", options.rollover)];
  if (options.digestCron) jobs.push(job("digest", options.digestCron, options.digest));
  if (options.lowStockCron && options.lowStock) jobs.push(job("low-stock", options.lowStockCron, options.lowStock));
  if (options.socialPublish) jobs.push(job("social-scheduled", "* * * * *", options.socialPublish));
  if (options.paReminders) jobs.push(job("pa-reminders", "* * * * *", options.paReminders));
  if (options.integrationsRefresh) jobs.push(job("integrations-refresh", "17 4 * * *", options.integrationsRefresh));
  if (options.storageHousekeeping) jobs.push(job("storage-housekeeping", "43 3 * * *", options.storageHousekeeping));
  if (options.issuesAudit) jobs.push(job("issues-audit", "23 2 * * *", options.issuesAudit));
  return jobs;
}
