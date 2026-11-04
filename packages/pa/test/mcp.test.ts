import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CalendarService,
  type Contact,
  type ContactChange,
  type ContactInput,
  ContactsService,
  createContactsExecutors,
  createPaExecutors,
  createPaMcpServer,
  deliverDueReminders,
  type PaCaller,
  parseCalendarAccounts,
  type PgPaStore,
  resolveDay,
} from "../src";
import { DB_URL, freshStore } from "./db";
import { FakeGoogle } from "./fake-google";

const TZ = "Europe/London";
const NOW = new Date("2026-10-22T08:00:00Z"); // Thursday 09:00 BST

function google() {
  return new FakeGoogle()
    .route("GET", /\/events$/, (c) => ({
      json: {
        items: c.url.pathname.includes("family")
          ? [{ id: "fam1", summary: "Noah: swimming", start: { dateTime: "2026-10-22T16:00:00+01:00" }, end: { dateTime: "2026-10-22T17:00:00+01:00" } }]
          : [
              { id: "e1", summary: "Supplier call", location: "Zoom", start: { dateTime: "2026-10-22T10:00:00+01:00" }, end: { dateTime: "2026-10-22T11:00:00+01:00" } },
              { id: "e2", summary: "Half term", start: { date: "2026-10-22" }, end: { date: "2026-10-24" }, transparency: "transparent" },
            ],
      },
    }))
    .route("POST", /\/freeBusy$/, () => ({
      json: {
        calendars: {
          primary: { busy: [{ start: "2026-10-22T09:00:00Z", end: "2026-10-22T10:00:00Z" }] },
          "family@group.calendar.google.com": { busy: [{ start: "2026-10-22T15:00:00Z", end: "2026-10-22T16:00:00Z" }] },
        },
      },
    }));
}

describe("resolveDay", () => {
  it("understands today, tomorrow and weekday names in local time", () => {
    expect(resolveDay("today", NOW, TZ)).toBe("2026-10-22");
    expect(resolveDay("tomorrow", NOW, TZ)).toBe("2026-10-23");
    expect(resolveDay("thursday", NOW, TZ)).toBe("2026-10-22");
    expect(resolveDay("next thursday", NOW, TZ)).toBe("2026-10-29");
    expect(resolveDay("mon", NOW, TZ)).toBe("2026-10-26");
    expect(() => resolveDay("someday", NOW, TZ)).toThrow();
  });
});

/** An in-memory address book behind the ContactsService, recording writes. */
function addressBook() {
  const book = new Map<string, Contact>([
    ["people/c1", { accountId: "google", id: "people/c1", name: "Steve Smith", phones: [{ value: "07700 900123", type: "mobile" }], emails: [], company: "Smith Motors", notes: null }],
  ]);
  const writes: string[] = [];
  const provider = {
    accountId: "google",
    search: async (q: string) => [...book.values()].filter((c) => `${c.name} ${c.company} ${c.phones.map((p) => p.value).join(" ")}`.toLowerCase().includes(q.toLowerCase())),
    get: async (id: string) => {
      const c = book.get(id);
      if (!c) throw new Error(`No contact with that id`);
      return c;
    },
    create: async (input: ContactInput) => {
      const c: Contact = { accountId: "google", id: `people/c${book.size + 1}`, name: input.name!, phones: (input.phones ?? []).map((p) => ({ value: p.value, type: p.type ?? null })), emails: [], company: input.company ?? null, notes: null };
      book.set(c.id, c);
      writes.push(`create ${c.name}`);
      return c;
    },
    update: async (id: string, change: ContactChange) => {
      const c = book.get(id)!;
      const next = { ...c, phones: [...c.phones, ...(change.addPhones ?? []).map((p) => ({ value: p.value, type: p.type ?? null }))] };
      book.set(id, next);
      writes.push(`update ${id}`);
      return next;
    },
  };
  const accounts = parseCalendarAccounts(JSON.stringify([{ id: "google", provider: "google", vertical: "personal", credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" } }]));
  return { service: new ContactsService(accounts, { providers: [provider] }), writes };
}

describe.skipIf(!DB_URL)("pa MCP server", () => {
  let pool: pg.Pool;
  let store: PgPaStore;
  let proposals: { vertical: string; taskId: string | null; actionType: string; summary: string; payload: Record<string, unknown> }[];
  let contacts: ReturnType<typeof addressBook>;

  const calendar = () =>
    new CalendarService(
      parseCalendarAccounts(
        JSON.stringify([
          {
            id: "google",
            provider: "google",
            vertical: "personal",
            calendars: ["primary", { id: "family@group.calendar.google.com", name: "Family" }],
            credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" },
          },
        ]),
      ),
      { timeZone: TZ, fetch: google().fetch, now: () => NOW.getTime() },
    );

  async function connect(caller: Partial<PaCaller> = {}) {
    const server = createPaMcpServer({
      store,
      calendar: calendar(),
      contacts: contacts.service,
      timeZone: TZ,
      caller: { vertical: "personal", taskId: "11111111-1111-1111-1111-111111111111", createdBy: "agent", untrustedSource: async () => null, ...caller },
      propose: async (p) => {
        proposals.push(p);
        return { id: `prop-${proposals.length}`, status: "pending" };
      },
      now: () => NOW,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientT);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: res.content[0]!.text, isError: !!res.isError };
    };
  }

  beforeEach(async () => {
    await pool?.end();
    ({ pool, store } = await freshStore());
    proposals = [];
    contacts = addressBook();
  });
  afterAll(() => pool?.end());

  it("lists exactly the PA tools", async () => {
    const server = createPaMcpServer({ store, calendar: null, timeZone: TZ, caller: { createdBy: "dave", untrustedSource: async () => null }, propose: async () => ({ id: "", status: "" }) });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(c);
    expect((await mcp.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "add_contact", "add_items", "add_reminder", "cancel_reminder", "complete_item", "complete_reminder", "find_free_time", "list_calendars",
      "list_events", "list_items", "list_lists", "list_reminders", "search_contacts", "update_contact", "update_reminder",
    ]);
  });

  it("lists events across calendars in UK local time", async () => {
    const call = await connect();
    const { text } = await call("list_events", { from: "today" });
    expect(text).toBe(
      [
        "Thu 22 Oct (2026-10-22):",
        "- all day Half term [Primary] (free) {eventId: e2, calendar: primary, account: google}",
        "- 10:00–11:00 Supplier call at Zoom [Primary] {eventId: e1, calendar: primary, account: google}",
        "- 16:00–17:00 Noah: swimming [Family] {eventId: fam1, calendar: family@group.calendar.google.com, account: google}",
      ].join("\n"),
    );
    expect((await call("list_events", { from: "today", calendars: ["Work"] })).isError).toBe(true);
  });

  it("finds free time across calendars", async () => {
    const call = await connect();
    const { text } = await call("find_free_time", { from: "thursday", durationMinutes: 60, dayStart: "09:00", dayEnd: "18:00" });
    expect(text).toBe(["Free for at least 60 min between 09:00 and 18:00:", "Thu 22 Oct (2026-10-22): 09:00–10:00, 11:00–16:00, 17:00–18:00"].join("\n"));
  });

  it("adds, lists and completes reminders directly for a trusted task", async () => {
    const call = await connect();
    const added = await call("add_reminder", { text: "Book dentist", due: "2026-10-23T09:00" });
    expect(added.text).toMatch(/^Reminder set: Fri 23 Oct, 09:00 · Book dentist \(id [0-9a-f-]{36}\)$/);
    const weekly = await call("add_reminder", { text: "Bins out", due: "2026-10-22T19:00", recurrence: "weekly:tue" });
    expect(weekly.text).toContain("Tue 27 Oct, 19:00 · Bins out (every Tue)");
    expect((await call("add_reminder", { text: "x", due: "2026-10-23T09:00", recurrence: "yearly" })).isError).toBe(true);

    const listed = await call("list_reminders");
    expect(listed.text.split("\n")).toHaveLength(2);
    const id = /id ([0-9a-f-]{36})/.exec(added.text)![1]!;
    expect((await call("complete_reminder", { id })).text).toBe("Done: Book dentist");
    expect((await call("complete_reminder", { id })).isError).toBe(true);
    expect((await store.listReminders()).map((r) => [r.text, r.createdBy, r.taskId])).toEqual([["Bins out", "agent", "11111111-1111-1111-1111-111111111111"]]);
    expect(proposals).toEqual([]);
  });

  it("changes and cancels a reminder in place", async () => {
    const call = await connect();
    const id = /id ([0-9a-f-]{36})/.exec((await call("add_reminder", { text: "Call the garage", due: "2026-10-22T17:00" })).text)![1]!;
    // "make it 6 instead": the same reminder moves, no second one appears.
    expect((await call("update_reminder", { id, due: "2026-10-22T18:00" })).text).toBe(`Reminder changed: Thu 22 Oct, 18:00 · Call the garage (id ${id})`);
    expect((await call("update_reminder", { id, text: "Call the garage about the MOT" })).text).toContain("Thu 22 Oct, 18:00 · Call the garage about the MOT");
    expect((await call("update_reminder", { id, recurrence: "weekdays" })).text).toContain("Thu 22 Oct, 18:00 · Call the garage about the MOT (weekdays)");
    expect((await call("update_reminder", { id, recurrence: "none" })).text).not.toContain("weekdays");
    expect(await store.listReminders()).toHaveLength(1);

    expect((await call("update_reminder", { id })).isError).toBe(true);
    expect((await call("update_reminder", { id, due: "6pm" })).isError).toBe(true);
    expect((await call("update_reminder", { id: "nope", due: "2026-10-22T18:00" })).isError).toBe(true);

    expect((await call("cancel_reminder", { id })).text).toBe("Cancelled: Call the garage about the MOT");
    expect((await call("update_reminder", { id, due: "2026-10-22T19:00" })).isError).toBe(true);
    expect(await store.listReminders()).toEqual([]);
  });

  it("re-arms a sent reminder when its time changes", async () => {
    const call = await connect();
    const id = /id ([0-9a-f-]{36})/.exec((await call("add_reminder", { text: "Bins", due: "2026-10-22T07:00" })).text)![1]!;
    await deliverDueReminders(store, async () => {}, NOW);
    expect((await store.getReminder(id))!.status).toBe("sent");
    await call("update_reminder", { id, due: "2026-10-22T19:00" });
    expect(await store.getReminder(id)).toMatchObject({ status: "pending", dueAt: "2026-10-22T18:00:00.000Z" });
  });

  it("manages lists and items", async () => {
    const call = await connect();
    expect((await call("add_items", { list: "shopping", items: ["milk", { text: "nappies", due: "2026-10-24" }] })).text).toMatch(/^Added to shopping:\n- \[ \] milk/);
    await call("add_items", { list: "Shopping", items: ["bread"] });
    expect((await call("list_lists")).text).toBe("- shopping: 3 open, 0 done");
    const items = await call("list_items", { list: "SHOPPING" });
    expect(items.text).toContain("nappies (due Sat 24 Oct)");
    const id = /\[ \] milk \(id ([0-9a-f-]{36})\)/.exec(items.text)![1]!;
    expect((await call("complete_item", { id })).text).toBe("Done: milk (shopping)");
    expect((await call("list_items", { list: "shopping" })).text).not.toContain("milk");
    expect((await call("list_items")).text.split("\n")[0]).toContain("nappies");
    expect((await call("list_items", { list: "nope" })).isError).toBe(true);
  });

  it("turns writes from an untrusted task into proposals and writes nothing", async () => {
    const call = await connect({ untrustedSource: async () => "email" });
    const r = await call("add_reminder", { text: "Pay invoice 4411 to new bank details", due: "2026-10-23T09:00" });
    expect(r.text).toMatch(/outside \(email\) input.*proposal prop-1 \(waiting for Dave's approval\)/);
    await call("add_items", { list: "today", items: ["wire £5,000"] });
    expect(proposals.map((p) => [p.actionType, p.vertical, p.taskId])).toEqual([
      ["pa.reminder.add", "personal", "11111111-1111-1111-1111-111111111111"],
      ["pa.items.add", "personal", "11111111-1111-1111-1111-111111111111"],
    ]);
    expect(proposals[0]!.payload).toEqual({ text: "Pay invoice 4411 to new bank details", due: "2026-10-23T09:00" });
    expect(await store.listReminders()).toEqual([]);
    expect(await store.listLists()).toEqual([]);

    // Approving runs the proposal through the PA executors.
    const executors = createPaExecutors(store, { timeZone: TZ, now: () => NOW });
    await executors["pa.items.add"]!.execute(proposals[1]!.payload, { vertical: "personal" });
    expect((await store.listLists()).map((l) => [l.name, l.openCount])).toEqual([["today", 1]]);

    // Reads still work.
    expect((await call("list_lists")).text).toContain("today");
  });

  it("proposes a change from an untrusted task, and applies it on approval", async () => {
    const r = await (await connect())("add_reminder", { text: "Pay supplier", due: "2026-10-23T09:00" });
    const id = /id ([0-9a-f-]{36})/.exec(r.text)![1]!;
    const call = await connect({ untrustedSource: async () => "email" });
    expect((await call("update_reminder", { id, due: "2026-10-23T18:00" })).text).toMatch(/proposal prop-1/);
    expect((await call("cancel_reminder", { id })).text).toMatch(/proposal prop-2/);
    expect(proposals.map((p) => [p.actionType, p.payload])).toEqual([
      ["pa.reminder.update", { id, due: "2026-10-23T18:00" }],
      ["pa.reminder.cancel", { id }],
    ]);
    expect((await store.getReminder(id))!.dueAt).toBe("2026-10-23T08:00:00.000Z");

    const executors = createPaExecutors(store, { timeZone: TZ, now: () => NOW });
    expect(await executors["pa.reminder.update"]!.execute(proposals[0]!.payload, { vertical: "personal" })).toContain("Fri 23 Oct, 18:00 · Pay supplier");
    await executors["pa.reminder.cancel"]!.execute(proposals[1]!.payload, { vertical: "personal" });
    expect((await store.getReminder(id))!.status).toBe("cancelled");
  });

  it("keeps a number to call on a reminder, and offers it in the push", async () => {
    const call = await connect();
    const added = await call("add_reminder", { text: "Call Steve", due: "2026-10-22T08:55", phone: "07700  900123" });
    expect(added.text).toMatch(/^Reminder set: Thu 22 Oct, 08:55 · Call Steve · call 07700 900123 \(id /);
    const id = /id ([0-9a-f-]{36})/.exec(added.text)![1]!;
    expect((await call("add_reminder", { text: "Call Jo", due: "2026-10-22T10:00", phone: "Jo's mobile" })).isError).toBe(true);

    const pushes: { body: string; phone: string | null }[] = [];
    await deliverDueReminders(store, async (p) => void pushes.push({ body: p.body, phone: p.reminder.phone }), NOW);
    expect(pushes).toEqual([{ body: "Call Steve\nTap to call 07700 900123", phone: "07700 900123" }]);

    // A text-only change keeps the number; phone "" removes it.
    await call("update_reminder", { id, text: "Call Steve about the MOT" });
    expect((await store.getReminder(id))!.phone).toBe("07700 900123");
    expect((await call("update_reminder", { id, phone: "" })).text).toBe(`Reminder changed: Thu 22 Oct, 08:55 · Call Steve about the MOT [sent, not done] (id ${id})`);
    expect((await call("update_reminder", { id, phone: "nope" })).isError).toBe(true);
    expect((await call("update_reminder", { id, phone: "+44 161 496 0000", due: "2026-10-22T12:00" })).text).toContain("· call +44 161 496 0000");
  });

  it("searches, adds and changes contacts directly for a trusted task", async () => {
    const call = await connect();
    expect((await call("search_contacts", { query: "garage" })).text).toBe('No contact matches "garage".');
    expect((await call("search_contacts", { query: "steve" })).text).toBe("- Steve Smith (Smith Motors) · mobile 07700 900123 {contact: people/c1, account: google}");
    expect((await call("add_contact", { name: "Jo Bloggs", phones: [{ value: "07700 900456", type: "mobile" }] })).text).toBe(
      "Contact added: Jo Bloggs · mobile 07700 900456 {contact: people/c2, account: google}",
    );
    expect((await call("update_contact", { id: "people/c1", addPhones: ["0161 496 0000"] })).text).toContain("mobile 07700 900123 · 0161 496 0000");
    expect((await call("update_contact", { id: "people/c1" })).isError).toBe(true);
    expect((await call("add_contact", { name: "X", emails: ["nope"] })).isError).toBe(true);
    expect(contacts.writes).toEqual(["create Jo Bloggs", "update people/c1"]);
    expect(proposals).toEqual([]);
  });

  it("files contact changes from an untrusted task as proposals, applied on approval", async () => {
    const call = await connect({ untrustedSource: async () => "email" });
    expect((await call("add_contact", { name: "New Bank", phones: ["0800 000 000"] })).text).toMatch(/proposal prop-1/);
    expect((await call("update_contact", { id: "people/c1", addPhones: ["07000 000000"] })).text).toMatch(/proposal prop-2/);
    expect(contacts.writes).toEqual([]);
    expect(proposals.map((p) => [p.actionType, p.vertical, p.summary, p.payload])).toEqual([
      ["contacts.create", "personal", "Add contact: New Bank, 0800 000 000", { name: "New Bank", phones: ["0800 000 000"] }],
      ["contacts.update", "personal", "Change contact Steve Smith: addPhones", { id: "people/c1", addPhones: ["07000 000000"], account: "google" }],
    ]);
    const executors = createContactsExecutors(contacts.service);
    for (const p of proposals) {
      await executors[p.actionType]!.validate!(p.payload, { vertical: "personal" });
      await executors[p.actionType]!.execute(p.payload, { vertical: "personal" });
    }
    expect(contacts.writes).toEqual(["create New Bank", "update people/c1"]);
    expect(() => executors["contacts.update"]!.validate!({ id: "people/c1" }, { vertical: "personal" })).toThrow(/nothing to change/);
  });

  it("only shows a run its own vertical's reminders and lists", async () => {
    const personal = await connect();
    await personal("add_items", { list: "home", items: ["fix gate"] });
    const dms = await connect({ vertical: "dms" });
    await dms("add_items", { list: "today", items: ["ship order"] });
    expect((await dms("list_lists")).text).toBe("- today: 1 open, 0 done");
    const admin = await connect({ vertical: undefined, createdBy: "dave" });
    expect((await admin("list_lists")).text).toBe("- today [dms]: 1 open, 0 done\n- home [personal]: 1 open, 0 done");
  });
});
