/**
 * Calendar days in a timezone (Europe/London by default), so "today" for
 * budgets and digests follows Dave's clock rather than UTC.
 */

/** The local date `YYYY-MM-DD` of an instant in `timezone`. */
export function localDay(at: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Offset of `timezone` from UTC at an instant, in milliseconds. */
function offsetMs(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant local midnight starts `day` in `timezone`. */
export function dayStart(day: string, timezone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  // Two passes settle the offset across a DST change.
  let at = guess - offsetMs(new Date(guess), timezone);
  at = guess - offsetMs(new Date(at), timezone);
  return new Date(at);
}

/** `[start, end)` of a local day. */
export function dayRange(day: string, timezone: string): { start: Date; end: Date } {
  return { start: dayStart(day, timezone), end: dayStart(addDays(day, 1), timezone) };
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
