import { describeRecurrence, firstOccurrence, nextOccurrence, parseRecurrence, type Recurrence } from "./recurrence";
import type { CreatedBy, PgPaStore, Reminder } from "./store";
import { formatUk, localDate, localTime, parseInstant } from "./time";

export interface NewReminderInput {
  text: string;
  /** When: local `YYYY-MM-DDTHH:MM` (Europe/London) or ISO with an offset. For a recurring one, the first occurrence (and its time of day). */
  due: string;
  /** Optional: daily, weekdays, weekly:mon,thu, monthly:15, or the RRULE forms. */
  recurrence?: string | null;
  /** Optional number to call: the notification and the Today page then offer a Call button. */
  phone?: string | null;
}

/**
 * A phone number as typed ("07700 900123", "+44 20 7946 0000"), tidied, or null for none.
 * Throws for something that isn't a number, so a bad one fails when the reminder is set.
 */
export function normalisePhone(input: string | null | undefined): string | null {
  const v = (input ?? "").trim().replace(/\s+/g, " ");
  if (!v) return null;
  const digits = v.replace(/\D/g, "").length;
  if (!/^\+?[\d\s().-]+$/.test(v) || digits < 3 || digits > 15) throw new Error(`"${input}" is not a phone number`);
  return v;
}

/** The phone number for a `tel:` link: digits, with a leading + kept (and a "+44 (0)…" trunk zero dropped). */
export function telHref(phone: string): string {
  const intl = phone.trim().startsWith("+");
  return `tel:${intl ? "+" : ""}${(intl ? phone.replace(/\(0\)/g, "") : phone).replace(/\D/g, "")}`;
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
  return { text, dueAt, recurrence, localTime: time, timeZone, phone: normalisePhone(input.phone) };
}

export async function addReminder(
  store: PgPaStore,
  input: NewReminderInput,
  ctx: { vertical: string; createdBy: CreatedBy; taskId?: string | null; timeZone: string; now?: Date },
): Promise<Reminder> {
  const resolved = resolveReminder(input, ctx.timeZone, ctx.now ?? new Date());
  return store.addReminder({ ...resolved, vertical: ctx.vertical, createdBy: ctx.createdBy, taskId: ctx.taskId ?? null });
}

export interface ReminderChange {
  text?: string;
  /** New time, as for `NewReminderInput.due`. For a recurring one it sets the next occurrence and the time of day. */
  due?: string;
  /** New recurrence; "none" (or empty) makes it a one-off. Omit to keep it. */
  recurrence?: string | null;
  /** New number to call; null or "" removes it. Omit to keep it. */
  phone?: string | null;
}

/**
 * Changes an open reminder (null if there is none with that id). Changing only
 * the recurrence keeps its time of day; changing only the text keeps its schedule.
 */
export async function changeReminder(
  store: PgPaStore,
  id: string,
  change: ReminderChange,
  ctx: { vertical?: string; now?: Date },
): Promise<Reminder | null> {
  const existing = await store.getReminder(id, ctx.vertical);
  if (!existing || !["pending", "sent"].includes(existing.status)) return null;
  const text = change.text?.trim() || existing.text;
  const phone = change.phone === undefined ? undefined : normalisePhone(change.phone);
  if (change.due === undefined && change.recurrence === undefined) return store.updateReminder(id, { text, phone }, ctx.vertical);
  const r = change.recurrence;
  const recurrence = r === undefined ? existing.recurrence : !r?.trim() || /^none$/i.test(r.trim()) ? null : r;
  const due = change.due ?? `${localDate(new Date(existing.dueAt), existing.timeZone)}T${existing.localTime}`;
  const resolved = resolveReminder({ text, due, recurrence }, existing.timeZone, ctx.now ?? new Date());
  return store.updateReminder(id, { text, phone, schedule: resolved }, ctx.vertical);
}

/** One line for agents and notifications: "Thu 23 Oct, 09:00 · Call the garage · call 01632 960123 (weekdays) [id]". */
export function describeReminder(r: Reminder, options: { id?: boolean } = {}): string {
  const when = r.snoozedUntil ? `${formatUk(new Date(r.snoozedUntil), r.timeZone)} (snoozed)` : formatUk(new Date(r.dueAt), r.timeZone);
  const repeat = r.recurrence ? ` (${describeRecurrence(parseRecurrence(r.recurrence))})` : "";
  const state = r.status === "sent" ? " [sent, not done]" : r.status === "pending" ? "" : ` [${r.status}]`;
  const call = r.phone ? ` · call ${r.phone}` : "";
  return `${when} · ${r.text}${call}${repeat}${state}${options.id !== false ? ` (id ${r.id})` : ""}`;
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
    const text = late ? `${r.text} (was due ${formatUk(new Date(occurrenceDue ? r.dueAt : r.snoozedUntil!), r.timeZone)})` : r.text;
    const body = r.phone ? `${text}\nTap to call ${r.phone}` : text;
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
