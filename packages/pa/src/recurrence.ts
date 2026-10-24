import { addDays, daysInMonth, isTime, localDate, weekdayOf, zonedToUtc } from "./time";

/**
 * The RFC 5545 RRULE subset reminders support:
 * - `FREQ=DAILY`
 * - `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` (weekdays, or any set of days)
 * - `FREQ=MONTHLY;BYMONTHDAY=15` (in a shorter month, the 29th–31st fall on its last day)
 *
 * Occurrences keep their local wall-clock time across DST changes: a 09:00
 * daily reminder is 09:00 in Europe/London in both GMT and BST.
 */
export type Recurrence =
  | { freq: "DAILY" }
  | { freq: "WEEKLY"; byDay: number[] }
  | { freq: "MONTHLY"; byMonthDay: number };

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

export class RecurrenceError extends Error {}

const unsupported = (input: string) =>
  new RecurrenceError(
    `Unsupported recurrence "${input}". Use daily, weekdays, weekly:mon,thu, monthly:15, or the RRULE forms FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO,TH, FREQ=MONTHLY;BYMONTHDAY=15`,
  );

/** Parses an RRULE in the supported subset, or a shorthand (daily, weekdays, weekly:mon,thu, monthly:15). */
export function parseRecurrence(input: string): Recurrence {
  const s = input.trim().replace(/^RRULE:/i, "");
  const lower = s.toLowerCase();
  if (lower === "daily") return { freq: "DAILY" };
  if (lower === "weekdays") return { freq: "WEEKLY", byDay: [1, 2, 3, 4, 5] };
  const short = /^(weekly|monthly)\s*[:=]\s*(.+)$/.exec(lower);
  if (short) {
    if (short[1] === "monthly") return monthly(short[2]!, input);
    const days = short[2]!.split(/[\s,]+/).filter(Boolean).map((d) => {
      const n = DAY_NAMES[d] ?? DAY_CODES.indexOf(d.toUpperCase());
      if (n === undefined || n < 0) throw unsupported(input);
      return n;
    });
    return weekly(days, input);
  }

  const fields = new Map<string, string>();
  for (const part of s.split(";").filter(Boolean)) {
    const [k, v] = part.split("=");
    if (!k || !v) throw unsupported(input);
    fields.set(k.toUpperCase(), v.toUpperCase());
  }
  const freq = fields.get("FREQ");
  fields.delete("FREQ");
  if (fields.get("INTERVAL") === "1") fields.delete("INTERVAL");
  if (freq === "DAILY" && fields.size === 0) return { freq: "DAILY" };
  if (freq === "WEEKLY" && [...fields.keys()].every((k) => k === "BYDAY")) {
    const byDay = fields.get("BYDAY");
    if (!byDay) throw new RecurrenceError("FREQ=WEEKLY needs BYDAY, e.g. FREQ=WEEKLY;BYDAY=MO");
    return weekly(byDay.split(",").map((d) => DAY_CODES.indexOf(d)), input);
  }
  if (freq === "MONTHLY" && [...fields.keys()].every((k) => k === "BYMONTHDAY") && fields.has("BYMONTHDAY")) {
    return monthly(fields.get("BYMONTHDAY")!, input);
  }
  throw unsupported(input);
}

function weekly(days: number[], input: string): Recurrence {
  if (!days.length || days.some((d) => d < 0 || d > 6)) throw unsupported(input);
  return { freq: "WEEKLY", byDay: [...new Set(days)].sort() };
}

function monthly(value: string, input: string): Recurrence {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw unsupported(input);
  return { freq: "MONTHLY", byMonthDay: n };
}

/** The canonical RRULE text for storage. */
export function formatRecurrence(r: Recurrence): string {
  if (r.freq === "DAILY") return "FREQ=DAILY";
  if (r.freq === "WEEKLY") return `FREQ=WEEKLY;BYDAY=${r.byDay.map((d) => DAY_CODES[d]).join(",")}`;
  return `FREQ=MONTHLY;BYMONTHDAY=${r.byMonthDay}`;
}

/** "every day", "weekdays", "every Mon, Thu", "monthly on the 15th". */
export function describeRecurrence(r: Recurrence): string {
  if (r.freq === "DAILY") return "every day";
  if (r.freq === "WEEKLY") {
    if (r.byDay.join() === "1,2,3,4,5") return "weekdays";
    return `every ${r.byDay.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")}`;
  }
  const n = r.byMonthDay;
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `monthly on the ${n}${suffix}`;
}

function occursOn(r: Recurrence, day: string): boolean {
  if (r.freq === "DAILY") return true;
  if (r.freq === "WEEKLY") return r.byDay.includes(weekdayOf(day));
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return d === Math.min(r.byMonthDay, daysInMonth(y, m));
}

/**
 * The first occurrence strictly after `after`, at local `time` (HH:MM) in `timeZone`.
 * Days are walked in local time, so DST changes never shift the wall-clock time.
 */
export function nextOccurrence(r: Recurrence, after: Date, time: string, timeZone: string): Date {
  if (!isTime(time)) throw new RecurrenceError(`time must be HH:MM, got "${time}"`);
  let day = localDate(after, timeZone);
  for (let i = 0; i < 400; i++, day = addDays(day, 1)) {
    if (!occursOn(r, day)) continue;
    const at = zonedToUtc(day, time, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new RecurrenceError("no occurrence within 400 days");
}

/** The first occurrence at or after `from` (used when a recurring reminder is created). */
export function firstOccurrence(r: Recurrence, from: Date, time: string, timeZone: string): Date {
  return nextOccurrence(r, new Date(from.getTime() - 1), time, timeZone);
}

