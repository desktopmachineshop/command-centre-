import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalendarService } from "./calendar/service";
import type { CalendarEvent } from "./calendar/types";
import { type ContactsService, describeContact } from "./contacts/service";
import { ContactChangeSchema, ContactCreateSchema, contactChangeOf, contactInputOf } from "./executors";
import { addReminder, changeReminder, describeReminder, normalisePhone, resolveReminder } from "./reminders";
import type { CreatedBy, PgPaStore, ReminderStatus, TodoItem } from "./store";
import { addDays, dayBounds, formatUk, formatUkDate, isDate, isTime, localDate, localTime, weekdayOf } from "./time";

/** Who is calling, and whether their writes may happen directly. */
export interface PaCaller {
  /** The run's vertical; undefined for Dave's admin token (every vertical). */
  vertical?: string;
  taskId?: string | null;
  createdBy: CreatedBy;
  /**
   * Null when the caller may write directly (Dave, or a task started by chat,
   * cron or system); otherwise the untrusted source (email, webhook, social...)
   * whose writes must wait for approval as proposals.
   */
  untrustedSource: () => Promise<string | null>;
}

export interface PaMcpDeps {
  store: PgPaStore;
  calendar: CalendarService | null;
  /** Google Contacts on the calendar's Google accounts; null when none is connected. */
  contacts?: ContactsService | null;
  timeZone: string;
  caller: PaCaller;
  /** Files a proposal (the server's ActionService). Returns its id and status. */
  propose: (p: { vertical: string; taskId: string | null; actionType: string; summary: string; payload: Record<string, unknown> }) => Promise<{
    id: string;
    status: string;
  }>;
  now?: () => Date;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * A day from "today", "tomorrow", a weekday name (the next one, today included) or YYYY-MM-DD.
 * Local to `timeZone`.
 */
export function resolveDay(input: string | undefined, now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  const s = (input ?? "today").trim().toLowerCase();
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  if (isDate(s)) return s;
  const name = s.replace(/^next\s+/, "");
  const idx = DAY_NAMES.findIndex((d) => d === name || d.slice(0, 3) === name);
  if (idx >= 0) {
    const offset = (idx - weekdayOf(today) + 7) % 7;
    // "next thursday" said on a Thursday means a week today.
    return addDays(today, offset === 0 && s.startsWith("next") ? 7 : offset);
  }
  throw new Error(`"${input}" is not a day: use YYYY-MM-DD, today, tomorrow or a weekday name`);
}

function eventLine(e: CalendarEvent, timeZone: string, showCalendar: boolean): string {
  const when = e.allDay ? "all day" : `${localTime(new Date(e.start), timeZone)}–${localTime(new Date(e.end), timeZone)}`;
  const extra = [
    e.location ? `at ${e.location}` : null,
    showCalendar ? `[${e.calendarName}]` : null,
    !e.busy ? "(free)" : null,
    e.response === "declined" ? "(declined)" : e.response === "needsAction" ? "(not answered)" : e.status === "tentative" ? "(tentative)" : null,
    e.recurringEventId ? "(repeats)" : null,
  ].filter(Boolean);
  return `- ${when} ${e.title}${extra.length ? ` ${extra.join(" ")}` : ""} {eventId: ${e.id}, calendar: ${e.calendarId}, account: ${e.accountId}}`;
}

/** Agenda text grouped by local day. */
export function agendaText(events: CalendarEvent[], days: string[], timeZone: string): string {
  const showCalendar = new Set(events.map((e) => `${e.accountId}/${e.calendarId}`)).size > 1;
  const out: string[] = [];
  for (const day of days) {
    const { start, end } = dayBounds(day, timeZone);
    const on = events.filter((e) =>
      e.allDay ? e.start <= day && e.end > day : new Date(e.start) < end && new Date(e.end) > start,
    );
    out.push(`${formatUkDate(day)} (${day}):`);
    out.push(...(on.length ? on.map((e) => eventLine(e, timeZone, showCalendar)) : ["- nothing"]));
  }
  return out.join("\n");
}

function itemLine(i: TodoItem, showList: boolean): string {
  const due = i.dueDate ? ` (due ${formatUkDate(i.dueDate)})` : "";
  return `- ${i.done ? "[x]" : "[ ]"} ${i.text}${due}${showList ? ` [${i.listName}]` : ""} (id ${i.id})`;
}

/**
 * The `pa` MCP server: calendar reads, contacts, reminders and to-do lists.
 * Reads are open to every caller. Reminders, items and contacts are Dave's own
 * (nobody else is told of a change), so Dave and trusted tasks write them
 * directly; a task started by outside input gets a proposal instead, which
 * waits for Dave. Calendar writes are always proposals (`calendar.create` etc.
 * through the actions server), never tools here.
 */
export function createPaMcpServer(deps: PaMcpDeps): McpServer {
  const { store, calendar, timeZone, caller } = deps;
  const contacts = deps.contacts ?? null;
  const now = () => deps.now?.() ?? new Date();
  const server = new McpServer({ name: "pa", version: "0.1.0" });
  /** Writes land in the run's vertical; Dave's admin calls may name one (default personal). */
  const writeVertical = (requested?: string) => caller.vertical ?? requested ?? "personal";
  const vertical = z.string().optional().describe("Only used outside an agent run");

  /** Runs a write directly, or files it as a proposal when the task came from outside input. */
  const write = async (
    proposal: { actionType: string; summary: string; payload: Record<string, unknown>; vertical: string },
    direct: () => Promise<string>,
  ) => {
    const source = await caller.untrustedSource();
    if (!source) return text(await direct());
    const p = await deps.propose({ ...proposal, taskId: caller.taskId ?? null });
    return text(
      `This task was triggered by outside (${source}) input, so the change was not made: it is proposal ${p.id} (${p.status === "pending" ? "waiting for Dave's approval" : p.status}).`,
    );
  };

  // --- Calendar (read-only; writes are calendar.* proposals) ---

  server.registerTool(
    "list_calendars",
    { description: "The calendars you can read, and which ones events can be created on.", inputSchema: {} },
    async () => {
      if (!calendar?.configured) return text("No calendar is connected (CALENDAR_ACCOUNTS is empty).");
      const lines = calendar.calendars(caller.vertical).map((c) => `- ${c.name} {account: ${c.accountId}, calendar: ${c.calendarId}}${c.writable ? "" : " (read-only)"}`);
      return text(lines.join("\n") || "No calendars for this vertical.");
    },
  );

  server.registerTool(
    "list_events",
    {
      description:
        "Events across Dave's calendars, recurring events expanded, times in UK local time (Europe/London). Give from (and optionally to, inclusive) as YYYY-MM-DD, today, tomorrow or a weekday name. Default: today.",
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        calendars: z.array(z.string()).optional().describe("Calendar names or ids; default all"),
      },
    },
    async ({ from, to, calendars }) => {
      if (!calendar?.configured) return text("No calendar is connected (CALENDAR_ACCOUNTS is empty).");
      try {
        const first = resolveDay(from, now(), timeZone);
        const last = to ? resolveDay(to, now(), timeZone) : first;
        if (last < first) return fail("to is before from");
        const days: string[] = [];
        for (let d = first; d <= last && days.length < 62; d = addDays(d, 1)) days.push(d);
        const { events, errors } = await calendar.listEvents(dayBounds(first, timeZone).start, dayBounds(days[days.length - 1]!, timeZone).end, {
          vertical: caller.vertical,
          calendars,
        });
        const body = agendaText(events, days, timeZone);
        return text(errors.length ? `${body}\n\nCould not read: ${errors.join("; ")}` : body);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "find_free_time",
    {
      description:
        "Free slots across Dave's calendars (busy time from every calendar is combined; events marked free and declined invitations don't block). Days are YYYY-MM-DD, today, tomorrow or a weekday name; times are UK local.",
      inputSchema: {
        from: z.string().optional().describe("First day, default today"),
        to: z.string().optional().describe("Last day (inclusive), default same as from"),
        durationMinutes: z.number().int().positive().max(24 * 60).default(30),
        dayStart: z.string().default("09:00").describe("HH:MM, start of each day's window"),
        dayEnd: z.string().default("17:30").describe("HH:MM, end of each day's window"),
        weekdaysOnly: z.boolean().default(false),
        calendars: z.array(z.string()).optional(),
      },
    },
    async (a) => {
      if (!calendar?.configured) return text("No calendar is connected (CALENDAR_ACCOUNTS is empty).");
      try {
        if (!isTime(a.dayStart) || !isTime(a.dayEnd) || a.dayEnd <= a.dayStart) return fail("dayStart and dayEnd must be HH:MM with dayEnd later");
        const fromDay = resolveDay(a.from, now(), timeZone);
        const toDay = a.to ? resolveDay(a.to, now(), timeZone) : fromDay;
        if (toDay < fromDay) return fail("to is before from");
        const { slots, errors } = await calendar.findFreeTime({
          fromDay,
          toDay,
          minMinutes: a.durationMinutes,
          dayStart: a.dayStart,
          dayEnd: a.dayEnd,
          skipWeekdays: a.weekdaysOnly ? [0, 6] : undefined,
          vertical: caller.vertical,
          calendars: a.calendars,
        });
        const lines: string[] = [];
        for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
          const on = slots.filter((s) => s.day === d);
          if (!on.length && a.weekdaysOnly && [0, 6].includes(weekdayOf(d))) continue;
          lines.push(`${formatUkDate(d)} (${d}): ${on.length ? on.map((s) => `${localTime(s.start, timeZone)}–${localTime(s.end, timeZone)}`).join(", ") : "no free slot"}`);
        }
        const header = `Free for at least ${a.durationMinutes} min between ${a.dayStart} and ${a.dayEnd}:`;
        return text([header, ...lines, ...(errors.length ? [`Could not check: ${errors.join("; ")} (treat those calendars as unknown)`] : [])].join("\n"));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  // --- Contacts (Google, on the calendar's Google accounts) ---

  const noContacts = () => text("No Google account is connected for contacts (Accounts page → Google account).");

  server.registerTool(
    "search_contacts",
    {
      description:
        "Search Dave's Google contacts by name, phone number, email or company (e.g. \"Steve\", \"garage\", \"07700\"). Gives each contact's numbers, emails and its id for update_contact.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(30).default(10) },
    },
    async ({ query, limit }) => {
      if (!contacts?.configured) return noContacts();
      const { contacts: found, errors } = await contacts.search(query, { vertical: caller.vertical, limit });
      const body = found.length ? found.map((c) => `- ${describeContact(c)}`).join("\n") : `No contact matches "${query}".`;
      return errors.length && !found.length ? fail(`${body}\n${errors.join("; ")}`) : text(errors.length ? `${body}\n\nCould not search: ${errors.join("; ")}` : body);
    },
  );

  server.registerTool(
    "add_contact",
    {
      description:
        "Add a contact to Dave's Google contacts. Search first so you don't add a duplicate; to give an existing contact a new number use update_contact with addPhones. phones and emails: strings or {value, type} (type: mobile, home, work, other).",
      inputSchema: { ...ContactCreateSchema.shape, vertical },
    },
    async (a) => {
      if (!contacts?.configured) return noContacts();
      try {
        const input = contactInputOf(a);
        const { vertical: requested, ...payload } = a;
        return await write(
          { actionType: "contacts.create", vertical: writeVertical(requested), summary: `Add contact: ${[input.name, ...(input.phones ?? []).map((p) => p.value)].join(", ")}`.slice(0, 200), payload },
          async () => `Contact added: ${describeContact(await contacts.create(input, { vertical: caller.vertical, accountId: a.account }))}`,
        );
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "update_contact",
    {
      description:
        "Change a Google contact by id (people/c… from search_contacts). Give only what changes: name, company, notes (\"\" clears company or notes); phones or emails replace the whole list, addPhones or addEmails add to it (prefer these, so no number is lost).",
      inputSchema: ContactChangeSchema.shape,
    },
    async (a) => {
      if (!contacts?.configured) return noContacts();
      try {
        const change = contactChangeOf(a);
        if (!Object.keys(change).length) return fail("Give something to change: name, phones, addPhones, emails, addEmails, company or notes.");
        const current = await contacts.get(a.id, { vertical: caller.vertical, accountId: a.account });
        const what = Object.keys(change).join(", ");
        return await write(
          { actionType: "contacts.update", vertical: writeVertical(), summary: `Change contact ${current.name}: ${what}`.slice(0, 200), payload: { ...a, account: current.accountId } },
          async () => `Contact changed: ${describeContact(await contacts.update(a.id, change, { vertical: caller.vertical, accountId: current.accountId }))}`,
        );
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  // --- Reminders ---

  server.registerTool(
    "add_reminder",
    {
      description:
        "Remind Dave at a time (a push to his devices). due is UK local time YYYY-MM-DDTHH:MM. recurrence (optional): daily, weekdays, weekly:mon,thu, monthly:15 (or FREQ=... RRULE); due then sets the first occurrence and the time of day. phone (optional): for a reminder to call someone, the number to call (look it up with search_contacts); the notification then opens the phone's dialler with it.",
      inputSchema: { text: z.string().min(1), due: z.string().min(1), recurrence: z.string().optional(), phone: z.string().optional().describe("Number to call, e.g. 07700 900123"), vertical },
    },
    async (a) => {
      try {
        const v = writeVertical(a.vertical);
        const resolved = resolveReminder(a, timeZone, now());
        return await write(
          { actionType: "pa.reminder.add", vertical: v, summary: `Reminder ${formatUk(resolved.dueAt, timeZone)}: ${resolved.text}`, payload: { text: a.text, due: a.due, ...(a.recurrence ? { recurrence: a.recurrence } : {}), ...(a.phone ? { phone: a.phone } : {}) } },
          async () => {
            const r = await addReminder(store, a, { vertical: v, createdBy: caller.createdBy, taskId: caller.taskId, timeZone, now: now() });
            return `Reminder set: ${describeReminder(r)}`;
          },
        );
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_reminders",
    {
      description: "Dave's reminders, soonest first. status: open (default: waiting, or sent but not done), done, or all.",
      inputSchema: { status: z.enum(["open", "done", "all"]).default("open"), dueBy: z.string().optional().describe("Only those due by the end of this day"), limit: z.number().int().min(1).max(200).default(50) },
    },
    async ({ status, dueBy, limit }) => {
      try {
        const statuses: ReminderStatus[] = status === "open" ? ["pending", "sent"] : status === "done" ? ["done"] : ["pending", "sent", "done", "cancelled"];
        const dueBefore = dueBy ? dayBounds(resolveDay(dueBy, now(), timeZone), timeZone).end : undefined;
        const list = await store.listReminders({ vertical: caller.vertical, statuses, dueBefore, limit });
        return text(list.length ? list.map((r) => `- ${describeReminder(r)}`).join("\n") : "No reminders.");
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "update_reminder",
    {
      description:
        "Change an open reminder by id (from add_reminder or list_reminders): its text, its time (due, UK local YYYY-MM-DDTHH:MM), its recurrence (\"none\" makes it a one-off) and/or the number to call (phone; \"\" removes it). Give only what changes. Use this rather than adding a second reminder.",
      inputSchema: { id: z.string().min(1), text: z.string().optional(), due: z.string().optional(), recurrence: z.string().optional(), phone: z.string().optional() },
    },
    async ({ id, ...change }) => {
      if (change.text === undefined && change.due === undefined && change.recurrence === undefined && change.phone === undefined) return fail("Give text, due, recurrence or phone to change.");
      const existing = await store.getReminder(id, caller.vertical);
      if (!existing || !["pending", "sent"].includes(existing.status)) return fail(`No open reminder ${id}. Use list_reminders for ids.`);
      try {
        // Validate before proposing, so a bad time fails now rather than on approval.
        if (change.due) resolveReminder({ text: existing.text, due: change.due }, timeZone, now());
        normalisePhone(change.phone);
        const summary = `Change reminder "${existing.text}": ${Object.entries(change).map(([k, v]) => `${k} ${v}`).join(", ")}`.slice(0, 200);
        return await write({ actionType: "pa.reminder.update", vertical: existing.vertical, summary, payload: { id, ...change } }, async () => {
          const r = await changeReminder(store, id, change, { vertical: caller.vertical, now: now() });
          return r ? `Reminder changed: ${describeReminder(r)}` : "It is no longer open.";
        });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "cancel_reminder",
    { description: "Cancel an open reminder (for a recurring one, the whole series) without marking it done.", inputSchema: { id: z.string().min(1) } },
    async ({ id }) => {
      const existing = await store.getReminder(id, caller.vertical);
      if (!existing || !["pending", "sent"].includes(existing.status)) return fail(`No open reminder ${id}. Use list_reminders for ids.`);
      return write({ actionType: "pa.reminder.cancel", vertical: existing.vertical, summary: `Cancel reminder: ${existing.text}`, payload: { id } }, async () => {
        const r = await store.cancelReminder(id, caller.vertical);
        return r ? `Cancelled: ${r.text}` : "It is no longer open.";
      });
    },
  );

  server.registerTool(
    "complete_reminder",
    { description: "Mark a reminder done. For a recurring reminder this ends the series.", inputSchema: { id: z.string().min(1) } },
    async ({ id }) => {
      const existing = await store.getReminder(id, caller.vertical);
      if (!existing || !["pending", "sent"].includes(existing.status)) return fail(`No open reminder ${id}. Use list_reminders for ids.`);
      return write({ actionType: "pa.reminder.complete", vertical: existing.vertical, summary: `Done: ${existing.text}`, payload: { id } }, async () => {
        const r = await store.completeReminder(id, caller.vertical);
        return r ? `Done: ${r.text}` : "It was already done.";
      });
    },
  );

  // --- Lists ---

  server.registerTool(
    "list_lists",
    { description: "Dave's to-do lists (e.g. today, shopping, home, Noah) with open and done counts.", inputSchema: {} },
    async () => {
      const lists = await store.listLists(caller.vertical);
      if (!lists.length) return text("No lists yet. add_items creates one.");
      const many = new Set(lists.map((l) => l.vertical)).size > 1;
      return text(lists.map((l) => `- ${l.name}${many ? ` [${l.vertical}]` : ""}: ${l.openCount} open, ${l.doneCount} done`).join("\n"));
    },
  );

  server.registerTool(
    "add_items",
    {
      description: 'Add items to a to-do list by name ("shopping", "today", "home", "Noah"…); the list is created if it doesn\'t exist. Keep each item short.',
      inputSchema: {
        list: z.string().min(1),
        items: z.array(z.union([z.string().min(1), z.object({ text: z.string().min(1), due: z.string().optional().describe("YYYY-MM-DD") })])).min(1).max(100),
        vertical,
      },
    },
    async (a) => {
      const items = a.items.map((i) => (typeof i === "string" ? { text: i } : i));
      for (const i of items) if (i.due && !isDate(i.due)) return fail(`due must be YYYY-MM-DD, got "${i.due}"`);
      const v = writeVertical(a.vertical);
      return write(
        { actionType: "pa.items.add", vertical: v, summary: `Add to ${a.list}: ${items.map((i) => i.text).join(", ")}`.slice(0, 200), payload: { list: a.list, items } },
        async () => {
          const list = await store.ensureList(v, a.list);
          const added = await store.addItems(list.id, items.map((i) => ({ text: i.text, dueDate: i.due ?? null })), caller.createdBy);
          return `Added to ${list.name}:\n${added.map((i) => itemLine(i, false)).join("\n")}`;
        },
      );
    },
  );

  server.registerTool(
    "list_items",
    {
      description: "Items on a list by name, open first. Without a list: the top open items across lists (overdue and due today first, then the today list).",
      inputSchema: { list: z.string().optional(), includeDone: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50) },
    },
    async ({ list, includeDone, limit }) => {
      if (!list) {
        const top = await store.topItems({ vertical: caller.vertical, today: localDate(now(), timeZone), limit });
        return text(top.length ? top.map((i) => itemLine(i, true)).join("\n") : "Nothing open.");
      }
      const lists = (await store.listLists(caller.vertical)).filter((l) => l.name.toLowerCase() === list.trim().toLowerCase());
      if (!lists.length) return fail(`No list called "${list}". Lists: ${(await store.listLists(caller.vertical)).map((l) => l.name).join(", ") || "none"}`);
      const items = (await Promise.all(lists.map((l) => store.listItems(l.id, { includeDone, limit })))).flat();
      return text(items.length ? items.map((i) => itemLine(i, false)).join("\n") : `${lists[0]!.name} is empty.`);
    },
  );

  server.registerTool(
    "complete_item",
    { description: "Tick off a to-do item by id (from list_items).", inputSchema: { id: z.string().min(1) } },
    async ({ id }) => {
      const item = await store.getItem(id, caller.vertical);
      if (!item) return fail(`No item ${id}. Use list_items for ids.`);
      return write({ actionType: "pa.item.complete", vertical: item.vertical, summary: `Tick off: ${item.text} (${item.listName})`, payload: { id } }, async () => {
        await store.setItemDone(id, true, caller.vertical);
        return `Done: ${item.text} (${item.listName})`;
      });
    },
  );

  return server;
}
