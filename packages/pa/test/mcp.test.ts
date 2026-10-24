import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CalendarService, createPaExecutors, createPaMcpServer, type PaCaller, parseCalendarAccounts, type PgPaStore, resolveDay } from "../src";
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

describe.skipIf(!DB_URL)("pa MCP server", () => {
  let pool: pg.Pool;
  let store: PgPaStore;
  let proposals: { vertical: string; taskId: string | null; actionType: string; summary: string; payload: Record<string, unknown> }[];

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
  });
  afterAll(() => pool?.end());

  it("lists exactly the PA tools", async () => {
    const server = createPaMcpServer({ store, calendar: null, timeZone: TZ, caller: { createdBy: "dave", untrustedSource: async () => null }, propose: async () => ({ id: "", status: "" }) });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(c);
    expect((await mcp.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "add_items", "add_reminder", "complete_item", "complete_reminder", "find_free_time", "list_calendars",
      "list_events", "list_items", "list_lists", "list_reminders",
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
