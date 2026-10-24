/**
 * Wall-clock helpers for one IANA time zone (Europe/London by default), with
 * no dependencies: `Intl` gives offsets, these helpers do the arithmetic.
 */

export const DEFAULT_TIMEZONE = "Europe/London";

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall-clock reading of an instant in `timeZone`. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `YYYY-MM-DD` of an instant in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `HH:MM` of an instant in `timeZone`. */
export function localTime(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function offsetMs(at: number, timeZone: string): number {
  const p = localParts(new Date(at), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a local date and time happen in `timeZone`.
 * A time skipped by a spring-forward change moves forward by the gap (01:30 → 02:30 BST);
 * a time that happens twice in an autumn change resolves to the first (BST) one.
 */
export function zonedToUtc(day: string, time: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm, ss = 0] = time.split(":").map(Number) as [number, number, number?];
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const offsets = new Set([offsetMs(guess - 86_400_000, timeZone), offsetMs(guess, timeZone), offsetMs(guess + 86_400_000, timeZone)]);
  const candidates = [...offsets].map((o) => guess - o);
  const matches = candidates.filter((c) => {
    const p = localParts(new Date(c), timeZone);
    return p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm;
  });
  return new Date(matches.length ? Math.min(...matches) : Math.max(...candidates));
}

/** `[start, end)` of a local day. */
export function dayBounds(day: string, timeZone: string): { start: Date; end: Date } {
  return { start: zonedToUtc(day, "00:00", timeZone), end: zonedToUtc(addDays(day, 1), "00:00", timeZone) };
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a `YYYY-MM-DD`. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/**
 * Parses an instant from what an agent or Dave typed: an ISO date-time with an
 * offset or `Z` is taken as is; a bare `YYYY-MM-DDTHH:MM[:SS]` (or with a space)
 * is local time in `timeZone`; a bare date is local midnight.
 */
export function parseInstant(input: string, timeZone: string): Date {
  const s = input.trim();
  if (isDate(s)) return zonedToUtc(s, "00:00", timeZone);
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(s);
  if (local) return zonedToUtc(local[1]!, local[3] ? `${local[2]}:${local[3]}` : local[2]!, timeZone);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t);
  }
  throw new Error(`"${input}" is not a date-time: use YYYY-MM-DDTHH:MM (local ${timeZone} time) or ISO 8601 with an offset`);
}

const ukFormatters = new Map<string, Intl.DateTimeFormat>();
/** UK style, e.g. "Thu 23 Oct, 14:30" (24-hour clock, day before month). */
export function formatUk(at: Date, timeZone: string, options: { time?: boolean } = {}): string {
  const key = `${timeZone}|${options.time !== false}`;
  let f = ukFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(options.time !== false ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
    });
    ukFormatters.set(key, f);
  }
  return f.format(at);
}

/** "Thu 23 Oct" for a `YYYY-MM-DD`. */
export function formatUkDate(day: string): string {
  return formatUk(new Date(`${day}T12:00:00Z`), "UTC", { time: false });
}
