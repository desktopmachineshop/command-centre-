import { z } from "zod";
import type { CalendarService } from "./calendar/service";
import type { EventInput, EventPatch, EventReminder } from "./calendar/types";
import { addReminder, describeReminder } from "./reminders";
import type { PgPaStore } from "./store";
import { addDays, formatUk, isDate, parseInstant } from "./time";

/**
 * Structurally the server's `ActionExecutor`. The server passes the proposal's
 * vertical in `ctx.vertical`, so an approved write lands in the vertical that proposed it.
 */
export interface PaActionExecutor {
  description: string;
  validate?(payload: Record<string, unknown>, ctx: { vertical: string }): void | Promise<void>;
  execute(payload: Record<string, unknown>, ctx: { vertical?: string }): Promise<unknown>;
}

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new Error(`Invalid payload: ${r.error.issues.map((i) => `${i.path.join(".") || "payload"} ${i.message}`).join("; ")}`);
  return r.data;
}

const Reminders = z
  .union([
    z.literal("default"),
    z.literal("none"),
    z
      .array(z.object({ method: z.enum(["popup", "email"]).default("popup"), minutes: z.number().int().min(0).max(40_320) }))
      .max(5, "Google allows at most 5 reminders per event"),
  ])
  .optional()
  .describe('"default" (the calendar\'s own), "none", or up to 5 of {method: "popup"|"email", minutes before}');

const Target = {
  accountId: z.string().optional().describe("Calendar account id; default: this vertical's first account"),
  calendar: z.string().optional().describe('Calendar id or name; default: the account\'s first writable calendar (usually "primary")'),
};

export const CalendarCreate = z.object({
  title: z.string().min(1),
  start: z.string().min(1).describe("YYYY-MM-DDTHH:MM local UK time, or YYYY-MM-DD for an all-day event"),
  end: z.string().optional().describe("Same format as start. For all-day events, the last day (inclusive). Default: start + durationMinutes"),
  durationMinutes: z.number().int().positive().max(24 * 60 * 14).optional().describe("Used when end is omitted. Default 60"),
  location: z.string().optional(),
  description: z.string().optional(),
  reminders: Reminders,
  busy: z.boolean().optional().describe("false shows the time as free. Default true"),
  ...Target,
});

export const CalendarUpdate = z.object({
  eventId: z.string().min(1),
  title: z.string().min(1).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  durationMinutes: z.number().int().positive().max(24 * 60 * 14).optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  reminders: Reminders,
  busy: z.boolean().optional(),
  ...Target,
});

export const CalendarDelete = z.object({ eventId: z.string().min(1), title: z.string().optional().describe("For the approval card only"), ...Target });

function reminderList(r: z.infer<typeof Reminders>): EventReminder[] | undefined {
  if (r === undefined || r === "default") return undefined;
  if (r === "none") return [];
  return r.map((x) => ({ method: x.method, minutes: x.minutes }));
}

type Times = Pick<EventInput, "start" | "end">;

/** Start and end in the calendar's terms; all-day `end` is inclusive for callers, exclusive for Google. */
export function resolveTimes(p: { start: string; end?: string; durationMinutes?: number }, timeZone: string): Times {
  if (isDate(p.start)) {
    const last = p.end ?? p.start;
    if (!isDate(last)) throw new Error("an all-day event (start YYYY-MM-DD) needs end as YYYY-MM-DD too");
    if (last < p.start) throw new Error("end is before start");
    return { start: { date: p.start }, end: { date: addDays(last, 1) } };
  }
  const start = parseInstant(p.start, timeZone);
  const end = p.end ? parseInstant(p.end, timeZone) : new Date(start.getTime() + (p.durationMinutes ?? 60) * 60_000);
  if (end <= start) throw new Error("end must be after start");
  return { start: { at: start }, end: { at: end } };
}

function describeTimes(t: Times, timeZone: string): string {
  if ("date" in t.start) return `${t.start.date} (all day)`;
  return `${formatUk(t.start.at, timeZone)}–${formatUk((t.end as { at: Date }).at, timeZone).split(", ").pop()}`;
}

/** calendar.create / calendar.update / calendar.delete: always proposals, `draft` unless a vertical says otherwise. */
export function createCalendarExecutors(calendar: CalendarService): Record<string, PaActionExecutor> {
  const tz = calendar.timeZone;
  const target = (vertical: string | undefined, p: { accountId?: string; calendar?: string }) => calendar.resolveWritable(vertical, p.accountId, p.calendar);
  return {
    "calendar.create": {
      description:
        "Create a calendar event. payload: { title, start (YYYY-MM-DDTHH:MM UK time, or YYYY-MM-DD all day), end? | durationMinutes? (default 60), location?, description?, reminders? (\"default\" | \"none\" | [{method: popup|email, minutes}]), busy?, accountId?, calendar? }. Find a free slot with the pa tool find_free_time first.",
      validate(payload, { vertical }) {
        const p = parse(CalendarCreate, payload);
        resolveTimes(p, tz);
        target(vertical, p);
      },
      async execute(payload, { vertical }) {
        const p = parse(CalendarCreate, payload);
        const ref = target(vertical, p);
        const times = resolveTimes(p, tz);
        const event = await calendar.create(ref, {
          title: p.title,
          ...times,
          location: p.location,
          description: p.description,
          reminders: reminderList(p.reminders),
          busy: p.busy,
          timeZone: tz,
        });
        return { eventId: event.id, calendar: ref.name, when: describeTimes(times, tz), url: event.url };
      },
    },
    "calendar.update": {
      description:
        "Change a calendar event. payload: { eventId, accountId?, calendar?, and any of: title, start, end, durationMinutes, location, description, reminders, busy }. Get eventId (and calendar) from list_events.",
      validate(payload, { vertical }) {
        const p = parse(CalendarUpdate, payload);
        if (p.end && !p.start) throw new Error("give start together with end");
        if (p.start) resolveTimes({ ...p, start: p.start }, tz);
        target(vertical, p);
      },
      async execute(payload, { vertical }) {
        const p = parse(CalendarUpdate, payload);
        const ref = target(vertical, p);
        const patch: EventPatch = { timeZone: tz };
        if (p.title !== undefined) patch.title = p.title;
        if (p.location !== undefined) patch.location = p.location;
        if (p.description !== undefined) patch.description = p.description;
        if (p.busy !== undefined) patch.busy = p.busy;
        const reminders = reminderList(p.reminders);
        if (reminders !== undefined) patch.reminders = reminders;
        if (p.start) Object.assign(patch, resolveTimes({ ...p, start: p.start }, tz));
        const event = await calendar.update(ref, p.eventId, patch);
        return { eventId: event.id, calendar: ref.name, url: event.url };
      },
    },
    "calendar.delete": {
      description: "Delete a calendar event. payload: { eventId, accountId?, calendar?, title? }. For one instance of a recurring event, use that instance's eventId.",
      validate(payload, { vertical }) {
        target(vertical, parse(CalendarDelete, payload));
      },
      async execute(payload, { vertical }) {
        const p = parse(CalendarDelete, payload);
        const ref = target(vertical, p);
        await calendar.delete(ref, p.eventId);
        return { deleted: p.eventId, calendar: ref.name };
      },
    },
  };
}

const ReminderAdd = z.object({ text: z.string().min(1), due: z.string().min(1), recurrence: z.string().optional().nullable() });
const ById = z.object({ id: z.string().min(1) });
const ItemsAdd = z.object({
  list: z.string().min(1),
  items: z.array(z.object({ text: z.string().min(1), due: z.string().optional().nullable() })).min(1).max(100),
});

/**
 * PA writes proposed by a task that outside input (email, webhook, social)
 * triggered. Trusted tasks and Dave write directly through the pa MCP tools;
 * these exist so an untrusted task's request waits for Dave's approval.
 */
export function createPaExecutors(store: PgPaStore, options: { timeZone: string; now?: () => Date }): Record<string, PaActionExecutor> {
  const vertical = (ctx: { vertical?: string }) => ctx.vertical ?? "personal";
  return {
    "pa.reminder.add": {
      description: "Add a reminder (only needed when the pa tools say a proposal is required). payload: { text, due, recurrence? }",
      validate(payload) {
        parse(ReminderAdd, payload);
      },
      async execute(payload, ctx) {
        const p = parse(ReminderAdd, payload);
        const r = await addReminder(store, p, { vertical: vertical(ctx), createdBy: "agent", timeZone: options.timeZone, now: options.now?.() });
        return describeReminder(r);
      },
    },
    "pa.reminder.complete": {
      description: "Mark a reminder done. payload: { id }",
      validate(payload) {
        parse(ById, payload);
      },
      async execute(payload, ctx) {
        const r = await store.completeReminder(parse(ById, payload).id, vertical(ctx));
        if (!r) throw new Error("no open reminder with that id");
        return describeReminder(r);
      },
    },
    "pa.items.add": {
      description: "Add items to a to-do list, creating the list if needed. payload: { list, items: [{ text, due? (YYYY-MM-DD) }] }",
      validate(payload) {
        const p = parse(ItemsAdd, payload);
        for (const i of p.items) if (i.due && !isDate(i.due)) throw new Error(`due must be YYYY-MM-DD, got "${i.due}"`);
      },
      async execute(payload, ctx) {
        const p = parse(ItemsAdd, payload);
        const list = await store.ensureList(vertical(ctx), p.list);
        const added = await store.addItems(list.id, p.items.map((i) => ({ text: i.text, dueDate: i.due ?? null })), "agent");
        return `${added.length} added to ${list.name}`;
      },
    },
    "pa.item.complete": {
      description: "Tick off a to-do item. payload: { id }",
      validate(payload) {
        parse(ById, payload);
      },
      async execute(payload, ctx) {
        const item = await store.setItemDone(parse(ById, payload).id, true, vertical(ctx));
        if (!item) throw new Error("no item with that id");
        return `${item.text} done`;
      },
    },
  };
}
