import type { CalendarService } from "./calendar/service";
import type { CalendarEvent } from "./calendar/types";
import type { PgPaStore, Reminder, TodoItem, TodoList } from "./store";
import { dayBounds, localDate } from "./time";

export interface TodayView {
  day: string;
  timeZone: string;
  calendarConfigured: boolean;
  events: CalendarEvent[];
  calendarErrors: string[];
  /** Open reminders due by the end of the day (including overdue and sent-but-not-done). */
  reminders: Reminder[];
  /** Open reminders after today, the next few. */
  upcoming: Reminder[];
  lists: (TodoList & { items: TodoItem[] })[];
}

/** Everything the Today page shows for one local day. */
export async function buildToday(
  deps: { store: PgPaStore; calendar: CalendarService | null; timeZone: string },
  options: { day?: string; now?: Date; vertical?: string; includeDone?: boolean } = {},
): Promise<TodayView> {
  const now = options.now ?? new Date();
  const day = options.day ?? localDate(now, deps.timeZone);
  const { start, end } = dayBounds(day, deps.timeZone);
  const [cal, open, lists] = await Promise.all([
    deps.calendar?.configured ? deps.calendar.listEvents(start, end, { vertical: options.vertical }) : Promise.resolve({ events: [], errors: [] }),
    deps.store.listReminders({ vertical: options.vertical, limit: 200 }),
    deps.store.listLists(options.vertical),
  ]);
  const dueBy = (r: Reminder) => Math.min(Date.parse(r.dueAt), r.snoozedUntil ? Date.parse(r.snoozedUntil) : Infinity);
  return {
    day,
    timeZone: deps.timeZone,
    calendarConfigured: !!deps.calendar?.configured,
    events: cal.events,
    calendarErrors: cal.errors,
    reminders: open.filter((r) => r.status === "sent" || dueBy(r) < end.getTime()),
    upcoming: open.filter((r) => r.status !== "sent" && dueBy(r) >= end.getTime()).slice(0, 10),
    lists: await Promise.all(lists.map(async (l) => ({ ...l, items: await deps.store.listItems(l.id, { includeDone: options.includeDone ?? true, limit: 200 }) }))),
  };
}
