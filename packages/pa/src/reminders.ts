import { describeRecurrence, firstOccurrence, nextOccurrence, parseRecurrence, type Recurrence } from "./recurrence";
import type { CreatedBy, PgPaStore, Reminder } from "./store";
import { formatUk, localTime, parseInstant } from "./time";

export interface NewReminderInput {
  text: string;
  /** When: local `YYYY-MM-DDTHH:MM` (Europe/London) or ISO with an offset. For a recurring one, the first occurrence (and its time of day). */
  due: string;
  /** Optional: daily, weekdays, weekly:mon,thu, monthly:15, or the RRULE forms. */
  recurrence?: string | null;
}

/** Resolves a reminder request into what the store keeps. Throws a readable error for bad input. */
export function resolveReminder(input: NewReminderInput, timeZone: string, now: Date) {
  const text = input.text.trim();
  if (!text) throw new Error("text must not be empty");
  const at = parseInstant(input.due, timeZone);
  const recurrence: Recurrence | null = input.recurrence?.trim() ? parseRecurrence(input.recurrence) : null;
  const time = localTime(at, timeZone);
  // A recurring reminder starts at its first matching day on or after the given date (and not in the past).
  const dueAt = recurrence ? firstOccurrence(recurrence, new Date(Math.max(at.getTime(), now.getTime())), time, timeZone) : at;
  return { text, dueAt, recurrence, localTime: time, timeZone };
}

export async function addReminder(
  store: PgPaStore,
  input: NewReminderInput,
  ctx: { vertical: string; createdBy: CreatedBy; taskId?: string | null; timeZone: string; now?: Date },
): Promise<Reminder> {
  const resolved = resolveReminder(input, ctx.timeZone, ctx.now ?? new Date());
  return store.addReminder({ ...resolved, vertical: ctx.vertical, createdBy: ctx.createdBy, taskId: ctx.taskId ?? null });
}

/** One line for agents and notifications: "Thu 23 Oct, 09:00 · Call the garage (weekdays) [id]". */
export function describeReminder(r: Reminder, options: { id?: boolean } = {}): string {
  const when = r.snoozedUntil ? `${formatUk(new Date(r.snoozedUntil), r.timeZone)} (snoozed)` : formatUk(new Date(r.dueAt), r.timeZone);
  const repeat = r.recurrence ? ` (${describeRecurrence(parseRecurrence(r.recurrence))})` : "";
  const state = r.status === "sent" ? " [sent, not done]" : r.status === "pending" ? "" : ` [${r.status}]`;
  return `${when} · ${r.text}${repeat}${state}${options.id !== false ? ` (id ${r.id})` : ""}`;
}

export interface ReminderPush {
  reminder: Reminder;
  /** The reminder's due time as stored after this send (its current occurrence). */
  dueAt: Date;
  title: string;
  body: string;
}

/**
 * Sends every due reminder once and records it. One-off reminders become
 * "sent" (open until completed); recurring ones move to their next occurrence
 * after `now`, so a server that was down for days sends one alert, not a backlog.
 * A due snooze sends a re-alert and clears itself. Each delivery is claimed
 * with a compare-and-set before the push, so concurrent runs never send twice.
 */
export async function deliverDueReminders(
  store: PgPaStore,
  push: (p: ReminderPush) => Promise<void>,
  now: Date = new Date(),
): Promise<Reminder[]> {
  const delivered: Reminder[] = [];
  for (const r of await store.dueReminders(now)) {
    const snoozeDue = r.snoozedUntil !== null && new Date(r.snoozedUntil) <= now;
    const occurrenceDue = r.status === "pending" && new Date(r.dueAt) <= now;
    let next: { status: Reminder["status"]; dueAt: Date; snoozedUntil: Date | null } = {
      status: r.status,
      dueAt: new Date(r.dueAt),
      snoozedUntil: snoozeDue ? null : r.snoozedUntil ? new Date(r.snoozedUntil) : null,
    };
    if (occurrenceDue) {
      if (r.recurrence) {
        next = { ...next, status: "pending", dueAt: nextOccurrence(parseRecurrence(r.recurrence), now, r.localTime, r.timeZone) };
      } else next = { ...next, status: "sent" };
    }
    if (!(await store.markReminderSent(r, next, now))) continue;
    const late = now.getTime() - new Date(snoozeDue && !occurrenceDue ? r.snoozedUntil! : r.dueAt).getTime() > 15 * 60_000;
    const body = late ? `${r.text} (was due ${formatUk(new Date(occurrenceDue ? r.dueAt : r.snoozedUntil!), r.timeZone)})` : r.text;
    try {
      await push({ reminder: r, dueAt: next.dueAt, title: "Reminder", body });
    } catch (err) {
      // Recorded as sent already: a broken push channel must not resend it every minute.
      console.error("[reminders] push failed", err);
    }
    delivered.push(r);
  }
  return delivered;
}

/** Snooze presets offered on the Today page and in notifications. */
export function snoozeUntil(preset: string | number, now: Date, timeZone: string): Date {
  if (typeof preset === "number") return new Date(now.getTime() + preset * 60_000);
  const m = /^(\d+)\s*(m|min|minutes?|h|hours?)$/i.exec(preset.trim());
  if (m) return new Date(now.getTime() + Number(m[1]) * (m[2]!.toLowerCase().startsWith("h") ? 3_600_000 : 60_000));
  if (preset === "tomorrow") {
    const tomorrow = new Date(now.getTime() + 86_400_000);
    return parseInstant(`${new Intl.DateTimeFormat("en-CA", { timeZone }).format(tomorrow)}T09:00`, timeZone);
  }
  return parseInstant(preset, timeZone);
}
