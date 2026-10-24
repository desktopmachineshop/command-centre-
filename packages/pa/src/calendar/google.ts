import {
  CalendarAuthError,
  CalendarError,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarProvider,
  type EventInput,
  type EventPatch,
  type EventReminders,
  type Interval,
} from "./types";
import { createGoogleTokenProvider, GoogleAuthError, type GoogleOAuthCredentials, type GoogleTokenProvider, REAUTH_HINT } from "../google/oauth";

/**
 * Google Calendar API v3 over plain fetch.
 * - Auth: OAuth 2.0 refresh-token grant against https://oauth2.googleapis.com/token
 *   (https://developers.google.com/identity/protocols/oauth2/native-app#offline).
 * - Events: events.list with singleEvents=true and orderBy=startTime, so recurring
 *   events come back as their individual instances
 *   (https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
 * - Free/busy: freeBusy.query across calendars
 *   (https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).
 * - Writes: events.insert, events.patch, events.delete.
 */

export const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
/**
 * Read and write events on every calendar the account can see, their free/busy,
 * and the calendar list (only so `google:auth` can print calendar ids to configure).
 * https://developers.google.com/workspace/calendar/api/auth
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export type GoogleCredentials = GoogleOAuthCredentials;

export interface GoogleCalendarOptions {
  accountId: string;
  credentials: GoogleCredentials;
  calendars: CalendarInfo[];
  fetch?: typeof fetch;
  now?: () => number;
}

type GoogleTime = { dateTime?: string; date?: string; timeZone?: string };
type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  transparency?: "opaque" | "transparent";
  recurringEventId?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
};

export class GoogleCalendarProvider implements CalendarProvider {
  readonly accountId: string;
  private readonly fetch: typeof fetch;
  private readonly tokens: GoogleTokenProvider;

  constructor(private readonly options: GoogleCalendarOptions) {
    this.accountId = options.accountId;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.tokens = createGoogleTokenProvider({ ...options.credentials, fetch: this.fetch, now: options.now, label: `calendar account "${options.accountId}"` });
  }

  calendars(): CalendarInfo[] {
    return this.options.calendars;
  }

  private calendarName(id: string): string {
    return this.options.calendars.find((c) => c.id === id)?.name ?? id;
  }

  /** A valid access token (cached; refreshed before expiry). Auth failures become CalendarAuthError. */
  async accessToken(): Promise<string> {
    try {
      return await this.tokens.getAccessToken();
    } catch (err) {
      if (err instanceof GoogleAuthError) throw new CalendarAuthError(this.accountId, err.message);
      throw new CalendarError((err as Error).message);
    }
  }

  /** One API call; a 401 drops the cached token and retries once with a fresh one. */
  private async api<T>(method: string, path: string, init: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${GOOGLE_API}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const err = json?.error;
        const reason = err?.errors?.[0]?.reason ?? err?.status;
        const message = `Google Calendar ${method} ${path.split("?")[0]} failed: ${res.status} ${err?.message ?? res.statusText}${reason ? ` (${reason})` : ""}`;
        if (res.status === 401) throw new CalendarAuthError(this.accountId, `${message}. ${REAUTH_HINT}`);
        throw new GoogleApiError(res.status, reason ?? null, message);
      }
      return json as T;
    }
  }

  async listEvents(calendarId: string, from: Date, to: Date, timeZone: string): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.api<{ items?: GoogleEvent[]; nextPageToken?: string }>("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, {
        query: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
          timeZone,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const item of res.items ?? []) {
        if (item.status === "cancelled") continue;
        events.push(this.toEvent(calendarId, item));
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return events;
  }

  async freeBusy(calendarIds: string[], from: Date, to: Date, timeZone: string): Promise<Record<string, Interval[]>> {
    if (!calendarIds.length) return {};
    const res = await this.api<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
      "POST",
      "/freeBusy",
      { body: { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone, items: calendarIds.map((id) => ({ id })) } },
    );
    const out: Record<string, Interval[]> = {};
    for (const id of calendarIds) {
      const entry = res.calendars?.[id];
      if (entry?.errors?.length) {
        throw new CalendarError(
          `Google free/busy for calendar "${this.calendarName(id)}" (account ${this.accountId}) failed: ${entry.errors.map((e) => e.reason).join(", ")}`,
        );
      }
      out[id] = (entry?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    }
    return out;
  }

  async createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent> {
    const item = await this.api<GoogleEvent>("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, { body: toGoogleBody(input) });
    return this.toEvent(calendarId, item);
  }

  async updateEvent(calendarId: string, eventId: string, patch: EventPatch): Promise<CalendarEvent> {
    const item = await this.api<GoogleEvent>(
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { body: toGoogleBody(patch) },
    );
    return this.toEvent(calendarId, item);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.api("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (err) {
      // Already gone: deleting is idempotent.
      if (err instanceof GoogleApiError && err.status === 410) return;
      throw err;
    }
  }

  private toEvent(calendarId: string, item: GoogleEvent): CalendarEvent {
    const allDay = !item.start?.dateTime;
    const time = (t: GoogleTime | undefined) => (t?.dateTime ? new Date(t.dateTime).toISOString() : (t?.date ?? ""));
    const self = item.attendees?.find((a) => a.self);
    return {
      accountId: this.accountId,
      calendarId,
      calendarName: this.calendarName(calendarId),
      id: item.id,
      recurringEventId: item.recurringEventId ?? null,
      title: item.summary ?? "(no title)",
      start: time(item.start),
      end: time(item.end),
      allDay,
      location: item.location ?? null,
      description: item.description ?? null,
      busy: item.transparency !== "transparent",
      status: item.status === "tentative" ? "tentative" : item.status === "cancelled" ? "cancelled" : "confirmed",
      response: (self?.responseStatus as CalendarEvent["response"]) ?? null,
      reminders: item.reminders ? toReminders(item.reminders) : null,
      url: item.htmlLink ?? null,
    };
  }
}

export class GoogleApiError extends CalendarError {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
  }
}

function toReminders(r: NonNullable<GoogleEvent["reminders"]>): EventReminders {
  return {
    useDefault: r.useDefault ?? false,
    overrides: (r.overrides ?? []).map((o) => ({ method: o.method === "email" ? "email" : "popup", minutes: o.minutes })),
  };
}

function googleTime(t: { at: Date } | { date: string }, timeZone: string): GoogleTime {
  // An instant plus the zone: Google keeps the event at that wall time in Europe/London.
  return "at" in t ? { dateTime: t.at.toISOString(), timeZone } : { date: t.date };
}

/** Event fields in Google's shape; only the ones present (so it doubles as a PATCH body). */
export function toGoogleBody(input: Partial<EventInput> & { timeZone: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.summary = input.title;
  if (input.location !== undefined) body.location = input.location;
  if (input.description !== undefined) body.description = input.description;
  if (input.start) body.start = googleTime(input.start, input.timeZone);
  if (input.end) body.end = googleTime(input.end, input.timeZone);
  if (input.busy !== undefined) body.transparency = input.busy ? "opaque" : "transparent";
  if (input.reminders !== undefined) body.reminders = { useDefault: false, overrides: input.reminders };
  return body;
}
