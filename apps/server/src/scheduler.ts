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
