import { addDays, isTime, zonedToUtc } from "../time";
import type { Interval } from "./types";

/** Sorted, non-overlapping union of intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start.getTime() <= last.end.getTime()) {
      if (i.end > last.end) last.end = new Date(i.end);
    } else out.push({ start: new Date(i.start), end: new Date(i.end) });
  }
  return out;
}

export interface FreeTimeQuery {
  /** First and last local day, inclusive (YYYY-MM-DD). */
  fromDay: string;
  toDay: string;
  /** Local window each day, HH:MM, e.g. 09:00–17:30. */
  dayStart: string;
  dayEnd: string;
  /** Shortest slot worth returning. */
  minMinutes: number;
  timeZone: string;
  /** Skip these weekdays (0 = Sunday). */
  skipWeekdays?: number[];
  /** Nothing before this instant (now). */
  notBefore?: Date;
}

export interface FreeSlot {
  day: string;
  start: Date;
  end: Date;
  minutes: number;
}

/** Gaps of at least `minMinutes` between busy intervals, inside each day's local window. */
export function freeSlots(busy: Interval[], q: FreeTimeQuery): FreeSlot[] {
  if (!isTime(q.dayStart) || !isTime(q.dayEnd)) throw new Error("dayStart and dayEnd must be HH:MM");
  const merged = mergeIntervals(busy);
  const slots: FreeSlot[] = [];
  for (let day = q.fromDay, n = 0; day <= q.toDay && n < 62; day = addDays(day, 1), n++) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (q.skipWeekdays?.includes(weekday)) continue;
    let cursor = zonedToUtc(day, q.dayStart, q.timeZone).getTime();
    const end = zonedToUtc(day, q.dayEnd, q.timeZone).getTime();
    if (q.notBefore) cursor = Math.max(cursor, ceilToQuarter(q.notBefore.getTime()));
    const push = (from: number, to: number) => {
      const minutes = Math.floor((to - from) / 60_000);
      if (minutes >= q.minMinutes) slots.push({ day, start: new Date(from), end: new Date(to), minutes });
    };
    for (const b of merged) {
      if (cursor >= end) break;
      if (b.end.getTime() <= cursor || b.start.getTime() >= end) continue;
      if (b.start.getTime() > cursor) push(cursor, b.start.getTime());
      cursor = Math.max(cursor, b.end.getTime());
    }
    if (cursor < end) push(cursor, end);
  }
  return slots;
}

/** Slots start on a quarter hour when "now" cuts into the window. */
function ceilToQuarter(ms: number): number {
  const q = 15 * 60_000;
  return Math.ceil(ms / q) * q;
}
