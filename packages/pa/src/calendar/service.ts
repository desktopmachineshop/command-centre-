import { type CalendarAccount, createProvider, publicCalendarAccount } from "./accounts";
import { type FreeSlot, freeSlots, mergeIntervals } from "./freetime";
import {
  CalendarAuthError,
  CalendarError,
  type CalendarEvent,
  type CalendarProvider,
  type EventInput,
  type EventPatch,
  type Interval,
} from "./types";

/** The vertical that plans Dave's whole day, so it sees every account's events. */
export const PLANNING_VERTICAL = "personal";

export interface CalendarRef {
  accountId: string;
  calendarId: string;
  name: string;
  writable: boolean;
}

export interface CalendarServiceOptions {
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called when an account's credentials stop working (revoked or expired refresh token). */
  onAuthError?: (err: CalendarAuthError) => void;
  /** Tests inject providers directly. */
  providers?: CalendarProvider[];
}

/**
 * Every configured calendar account behind one interface, scoped per vertical:
 * a vertical reads and writes its own accounts, and the personal vertical can
 * also read every other account (work commitments block personal time too).
 * A failing calendar is reported alongside the others' results, never instead of them.
 */
export class CalendarService {
  readonly timeZone: string;
  private readonly providers = new Map<string, CalendarProvider>();
  private readonly accountVertical = new Map<string, string>();
  private readonly now: () => number;

  constructor(
    readonly accounts: CalendarAccount[],
    private readonly options: CalendarServiceOptions,
  ) {
    this.timeZone = options.timeZone;
    this.now = options.now ?? Date.now;
    const injected = new Map((options.providers ?? []).map((p) => [p.accountId, p]));
    for (const a of accounts) {
      this.providers.set(a.id, injected.get(a.id) ?? createProvider(a, { fetch: options.fetch, now: options.now }));
      this.accountVertical.set(a.id, a.vertical);
    }
  }

  get configured(): boolean {
    return this.accounts.length > 0;
  }

  publicAccounts(vertical?: string) {
    return this.accounts.filter((a) => this.canRead(vertical, a.id)).map(publicCalendarAccount);
  }

  private canRead(vertical: string | undefined, accountId: string): boolean {
    if (vertical === undefined || vertical === PLANNING_VERTICAL) return this.accountVertical.has(accountId);
    return this.accountVertical.get(accountId) === vertical;
  }

  private canWrite(vertical: string | undefined, accountId: string): boolean {
    return vertical === undefined ? this.accountVertical.has(accountId) : this.accountVertical.get(accountId) === vertical;
  }

  /** Calendars a vertical may read (undefined: Dave, everything). */
  calendars(vertical?: string): CalendarRef[] {
    const out: CalendarRef[] = [];
    for (const [accountId, provider] of this.providers) {
      if (!this.canRead(vertical, accountId)) continue;
      for (const c of provider.calendars()) {
        out.push({ accountId, calendarId: c.id, name: c.name, writable: c.writable && this.canWrite(vertical, accountId) });
      }
    }
    return out;
  }

  /**
   * Narrows to calendars matching `filter` entries: a calendar name or id, or
   * "accountId/calendarId". Unknown names are an error, so a typo isn't read as "no events".
   */
  private select(vertical: string | undefined, filter?: string[]): CalendarRef[] {
    const all = this.calendars(vertical);
    if (!filter?.length) return all;
    const wanted = filter.map((f) => f.trim().toLowerCase());
    const chosen = all.filter((c) =>
      wanted.some((w) => w === c.name.toLowerCase() || w === c.calendarId.toLowerCase() || w === `${c.accountId}/${c.calendarId}`.toLowerCase()),
    );
    const unknown = wanted.filter(
      (w) => !all.some((c) => w === c.name.toLowerCase() || w === c.calendarId.toLowerCase() || w === `${c.accountId}/${c.calendarId}`.toLowerCase()),
    );
    if (unknown.length) throw new CalendarError(`Unknown calendar ${unknown.map((u) => `"${u}"`).join(", ")}. Calendars: ${all.map((c) => c.name).join(", ")}`);
    return chosen;
  }

  private note(err: unknown): string {
    if (err instanceof CalendarAuthError) this.options.onAuthError?.(err);
    return (err as Error).message;
  }

  /** Events overlapping [from, to) across the vertical's calendars, recurring ones as instances, by start time. */
  async listEvents(from: Date, to: Date, options: { vertical?: string; calendars?: string[] } = {}): Promise<{ events: CalendarEvent[]; errors: string[] }> {
    const targets = this.select(options.vertical, options.calendars);
    const errors: string[] = [];
    const results = await Promise.all(
      targets.map((c) =>
        this.providers
          .get(c.accountId)!
          .listEvents(c.calendarId, from, to, this.timeZone)
          .catch((err) => {
            errors.push(`${c.name}: ${this.note(err)}`);
            return [] as CalendarEvent[];
          }),
      ),
    );
    const events = results.flat().sort((a, b) => sortKey(a, this.timeZone) - sortKey(b, this.timeZone) || a.title.localeCompare(b.title));
    return { events, errors: [...new Set(errors)] };
  }

  /** Merged busy time across the vertical's calendars (one free/busy call per account). */
  async busy(from: Date, to: Date, options: { vertical?: string; calendars?: string[] } = {}): Promise<{ busy: Interval[]; errors: string[] }> {
    const targets = this.select(options.vertical, options.calendars);
    const byAccount = new Map<string, CalendarRef[]>();
    for (const c of targets) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
    const errors: string[] = [];
    const busy: Interval[] = [];
    await Promise.all(
      [...byAccount].map(async ([accountId, cals]) => {
        try {
          const result = await this.providers.get(accountId)!.freeBusy(cals.map((c) => c.calendarId), from, to, this.timeZone);
          for (const list of Object.values(result)) busy.push(...list);
        } catch (err) {
          errors.push(`${accountId}: ${this.note(err)}`);
        }
      }),
    );
    return { busy: mergeIntervals(busy), errors };
  }

  async findFreeTime(q: {
    fromDay: string;
    toDay: string;
    minMinutes: number;
    dayStart: string;
    dayEnd: string;
    skipWeekdays?: number[];
    vertical?: string;
    calendars?: string[];
  }): Promise<{ slots: FreeSlot[]; errors: string[] }> {
    // Pad the query by a day each side; slots are cut to local windows anyway.
    const from = new Date(new Date(`${q.fromDay}T00:00:00Z`).getTime() - 86_400_000);
    const to = new Date(new Date(`${q.toDay}T00:00:00Z`).getTime() + 2 * 86_400_000);
    const { busy, errors } = await this.busy(from, to, { vertical: q.vertical, calendars: q.calendars });
    const slots = freeSlots(busy, { ...q, timeZone: this.timeZone, notBefore: new Date(this.now()) });
    return { slots, errors };
  }

  /** The calendar a write goes to: the one named, else the vertical's first writable calendar. */
  resolveWritable(vertical: string | undefined, accountId?: string, calendarId?: string): CalendarRef {
    const own = this.calendars(vertical).filter((c) => this.canWrite(vertical, c.accountId));
    const match = own.filter((c) => (!accountId || c.accountId === accountId) && (!calendarId || c.calendarId === calendarId || c.name.toLowerCase() === calendarId.toLowerCase()));
    if (!match.length) {
      const names = own.map((c) => `${c.accountId}/${c.calendarId}`).join(", ") || "none";
      throw new CalendarError(
        accountId || calendarId
          ? `No calendar ${[accountId, calendarId].filter(Boolean).join("/")} for vertical ${vertical ?? "(admin)"}. Its calendars: ${names}`
          : `Vertical ${vertical} has no calendar account (CALENDAR_ACCOUNTS)`,
      );
    }
    const writable = match.find((c) => c.writable);
    if (!writable) throw new CalendarError(`Calendar ${match[0]!.name} is read-only (write: false in CALENDAR_ACCOUNTS)`);
    return writable;
  }

  private provider(ref: CalendarRef): CalendarProvider {
    return this.providers.get(ref.accountId)!;
  }

  async create(ref: CalendarRef, input: EventInput): Promise<CalendarEvent> {
    return this.provider(ref).createEvent(ref.calendarId, input).catch((err) => this.rethrow(err));
  }

  async update(ref: CalendarRef, eventId: string, patch: EventPatch): Promise<CalendarEvent> {
    return this.provider(ref).updateEvent(ref.calendarId, eventId, patch).catch((err) => this.rethrow(err));
  }

  async delete(ref: CalendarRef, eventId: string): Promise<void> {
    return this.provider(ref).deleteEvent(ref.calendarId, eventId).catch((err) => this.rethrow(err));
  }

  private rethrow(err: unknown): never {
    this.note(err);
    throw err;
  }
}

/** Timed events by instant; all-day events sort to the start of their local day. */
function sortKey(e: CalendarEvent, _timeZone: string): number {
  return e.allDay ? Date.parse(`${e.start}T00:00:00Z`) - 86_400_000 / 2 : Date.parse(e.start);
}
