/** Provider-neutral calendar model. Google is the only provider today; others implement `CalendarProvider`. */

export interface EventReminder {
  method: "popup" | "email";
  /** Minutes before the start. */
  minutes: number;
}

export interface EventReminders {
  /** True: the calendar's default reminders apply (and `overrides` is empty). */
  useDefault: boolean;
  overrides: EventReminder[];
}

export interface CalendarEvent {
  accountId: string;
  calendarId: string;
  /** Calendar name as configured or reported by the provider. */
  calendarName: string;
  /** Provider event id. For an instance of a recurring event, the instance's own id. */
  id: string;
  /** Set on instances of a recurring event: the series' id. */
  recurringEventId: string | null;
  title: string;
  /** ISO instant (with Z) for timed events; `YYYY-MM-DD` for all-day events. */
  start: string;
  /** Exclusive end: an ISO instant, or the day after the last day for all-day events. */
  end: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  /** "busy" blocks time; "free" (Google "transparent") does not. */
  busy: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  /** Dave's own response when he was invited, else null. */
  response: "accepted" | "declined" | "tentative" | "needsAction" | null;
  reminders: EventReminders | null;
  url: string | null;
}

export interface Interval {
  start: Date;
  end: Date;
}

/** What callers give to create an event. Times are already resolved instants, or dates for all-day. */
export interface EventInput {
  title: string;
  start: { at: Date } | { date: string };
  end: { at: Date } | { date: string };
  location?: string;
  description?: string;
  /** IANA zone the event is anchored in (Europe/London), so it moves correctly with DST. */
  timeZone: string;
  /** Omitted: the calendar's defaults. [] means no reminders. */
  reminders?: EventReminder[];
  /** Busy (default) or free. */
  busy?: boolean;
}

export type EventPatch = Partial<EventInput> & { timeZone: string };

export interface CalendarInfo {
  id: string;
  name: string;
  /** May events be created here (configured `write` and provider access). */
  writable: boolean;
  primary: boolean;
}

export interface CalendarProvider {
  readonly accountId: string;
  /** The account's configured calendars. */
  calendars(): CalendarInfo[];
  /** Events overlapping [from, to), recurring events expanded into instances, sorted by start. */
  listEvents(calendarId: string, from: Date, to: Date, timeZone: string): Promise<CalendarEvent[]>;
  /** Busy intervals for each calendar over [from, to). */
  freeBusy(calendarIds: string[], from: Date, to: Date, timeZone: string): Promise<Record<string, Interval[]>>;
  createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent>;
  updateEvent(calendarId: string, eventId: string, patch: EventPatch): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export class CalendarError extends Error {}

/** The provider refused the credentials (e.g. a revoked or expired refresh token). */
export class CalendarAuthError extends CalendarError {
  constructor(
    readonly accountId: string,
    message: string,
  ) {
    super(message);
  }
}
