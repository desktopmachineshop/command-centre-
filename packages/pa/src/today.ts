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
  /** One list per business: its top-level to-dos and its sections, nested. */
  lists: BusinessList[];
}

/** A section with its to-dos and sub-sections. */
export interface SectionNode extends TodoList {
  items: TodoItem[];
  sections: SectionNode[];
}

/** A business's (vertical's) one list. */
export interface BusinessList {
  vertical: string;
  /** To-dos at the top of the list, outside any section. */
  items: TodoItem[];
  sections: SectionNode[];
}

/** Sections and items as one tree per vertical (sections already in tree order, items in position order). */
export function buildListTree(sections: TodoList[], items: TodoItem[]): BusinessList[] {
  const byVertical = new Map<string, BusinessList>();
  const business = (vertical: string) => {
    let b = byVertical.get(vertical);
    if (!b) byVertical.set(vertical, (b = { vertical, items: [], sections: [] }));
    return b;
  };
  const nodes = new Map<string, SectionNode>();
  for (const s of sections) nodes.set(s.id, { ...s, items: [], sections: [] });
  for (const s of sections) {
    const node = nodes.get(s.id)!;
    const parent = s.parentId ? nodes.get(s.parentId) : undefined;
    (parent ? parent.sections : business(s.vertical).sections).push(node);
  }
  for (const i of items) {
    const node = i.listId ? nodes.get(i.listId) : undefined;
    (node ? node.items : business(i.vertical).items).push(i);
  }
  return [...byVertical.values()];
}

/** Everything the Today page shows for one local day. */
export async function buildToday(
  deps: { store: PgPaStore; calendar: CalendarService | null; timeZone: string },
  options: { day?: string; now?: Date; vertical?: string; includeDone?: boolean } = {},
): Promise<TodayView> {
  const now = options.now ?? new Date();
  const day = options.day ?? localDate(now, deps.timeZone);
  const { start, end } = dayBounds(day, deps.timeZone);
  const [cal, open, sections, items] = await Promise.all([
    deps.calendar?.configured ? deps.calendar.listEvents(start, end, { vertical: options.vertical }) : Promise.resolve({ events: [], errors: [] }),
    deps.store.listReminders({ vertical: options.vertical, limit: 200 }),
    deps.store.listLists(options.vertical),
    deps.store.allItems({ vertical: options.vertical, includeDone: options.includeDone ?? true }),
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
    lists: buildListTree(sections, items),
  };
}
