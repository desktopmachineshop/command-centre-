import type { NewEvent, VerticalManifest } from "@cc/core";
import { Cron } from "croner";

/**
 * Turns every enabled vertical schedule into cron events. The dedupe key is
 * per minute, so several server replicas firing together create one event.
 */
export function startSchedules(verticals: VerticalManifest[], ingest: (e: NewEvent) => Promise<unknown>): Cron[] {
  const jobs: Cron[] = [];
  for (const vertical of verticals) {
    for (const schedule of vertical.schedules) {
      if (!schedule.enabled) continue;
      jobs.push(
        new Cron(schedule.cron, { timezone: schedule.timezone, protect: true }, async () => {
          const minute = new Date().toISOString().slice(0, 16);
          await ingest({
            source: "cron",
            vertical: vertical.id,
            kind: `schedule:${schedule.id}`,
            title: `Scheduled: ${vertical.name} / ${schedule.id}`,
            payload: { prompt: schedule.prompt, scheduleId: schedule.id },
            dedupeKey: `cron:${vertical.id}:${schedule.id}:${minute}`,
          }).catch((err) => console.error(`[schedule ${vertical.id}/${schedule.id}]`, err));
        }),
      );
    }
  }
  return jobs;
}

/**
 * Built-in jobs that are not agent runs: the daily digest (`digestCron`, off
 * when unset) and the budget-day rollover just after local midnight.
 */
export function startSystemJobs(options: {
  timezone: string;
  digestCron?: string;
  digest: () => Promise<unknown>;
  rollover: () => Promise<unknown>;
}): Cron[] {
  const job = (name: string, cron: string, fn: () => Promise<unknown>) =>
    new Cron(cron, { timezone: options.timezone, protect: true }, async () => {
      await fn().catch((err) => console.error(`[${name}]`, err));
    });
  const jobs = [job("rollover", "1 0 * * *", options.rollover)];
  if (options.digestCron) jobs.push(job("digest", options.digestCron, options.digest));
  return jobs;
}
