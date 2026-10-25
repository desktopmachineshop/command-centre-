import { describe, expect, it } from "vitest";
import { CalendarService, freeSlots, parseCalendarAccounts, publicCalendarAccount } from "../src";
import { FakeGoogle } from "./fake-google";

const TZ = "Europe/London";
const SECRET = "very-secret-client-secret";
const TOKEN = "1//very-secret-refresh-token";

const account = (over: Record<string, unknown> = {}) => ({
  id: "google",
  provider: "google",
  vertical: "personal",
  calendars: ["primary", { id: "family@group.calendar.google.com", name: "Family", write: false }],
  credentials: { clientId: "cid", clientSecret: SECRET, refreshToken: TOKEN },
  ...over,
});

describe("CALENDAR_ACCOUNTS", () => {
  it("parses accounts with string and object calendars", () => {
    const [a] = parseCalendarAccounts(JSON.stringify([account()]));
    expect(publicCalendarAccount(a!)).toEqual({
      id: "google",
      provider: "google",
      vertical: "personal",
      calendars: [
        { id: "primary", name: "Primary", writable: true, primary: true },
        { id: "family@group.calendar.google.com", name: "Family", writable: false, primary: false },
      ],
    });
    expect(JSON.stringify(publicCalendarAccount(a!))).not.toContain(SECRET);
    expect(parseCalendarAccounts(JSON.stringify([{ ...account(), calendars: undefined }]))[0]!.calendars).toEqual([{ id: "primary" }]);
    expect(parseCalendarAccounts("")).toEqual([]);
  });

  it("defaults credentials to the shared GOOGLE_* variables, with per-account overrides", () => {
    const env = { GOOGLE_CLIENT_ID: "shared-cid", GOOGLE_CLIENT_SECRET: "shared-secret", GOOGLE_REFRESH_TOKEN: "1//shared" };
    const [shared, override] = parseCalendarAccounts(
      JSON.stringify([account({ credentials: undefined }), account({ id: "other", credentials: { refreshToken: "1//other" } })]),
      env,
    );
    expect(shared!.credentials).toEqual({ clientId: "shared-cid", clientSecret: "shared-secret", refreshToken: "1//shared" });
    expect(override!.credentials).toEqual({ clientId: "shared-cid", clientSecret: "shared-secret", refreshToken: "1//other" });
    expect(() => parseCalendarAccounts(JSON.stringify([account({ credentials: undefined })]), {})).toThrow(/google needs GOOGLE_CLIENT_ID set/);
  });

  it("resolves env: references", () => {
    const [a] = parseCalendarAccounts(JSON.stringify([account({ credentials: { clientId: "cid", clientSecret: "env:G_SECRET", refreshToken: "env:G_TOKEN" } })]), {
      G_SECRET: SECRET,
      G_TOKEN: TOKEN,
    });
    expect(a!.credentials).toEqual({ clientId: "cid", clientSecret: SECRET, refreshToken: TOKEN });
    expect(() => parseCalendarAccounts(JSON.stringify([account({ credentials: { clientId: "cid", clientSecret: "env:NOPE", refreshToken: "x" } })]), {})).toThrow(
      /google\.credentials\.clientSecret refers to NOPE/,
    );
  });

  it("names the field, never the value, in errors", () => {
    const bad = (input: string) => {
      try {
        parseCalendarAccounts(input);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected an error");
    };
    const notJson = bad(`[{"credentials": {"refreshToken": "${TOKEN}"}`);
    expect(notJson).toMatch(/not valid JSON/);
    expect(notJson).not.toContain(TOKEN);

    const caldav = bad(JSON.stringify([account({ provider: "caldav" })]));
    expect(caldav).toMatch(/0\.provider/);
    expect(caldav).toMatch(/only provider "google"/);

    const wrongType = bad(JSON.stringify([account({ credentials: { clientId: "cid", clientSecret: 12345678, refreshToken: TOKEN } })]));
    expect(wrongType).toMatch(/0\.credentials\.clientSecret/);
    expect(wrongType).not.toContain("12345678");
    expect(wrongType).not.toContain(TOKEN);

    expect(bad(JSON.stringify([account(), account()]))).toMatch(/unique/);
  });
});

describe("free slots", () => {
  it("finds gaps inside each day's window, ignoring the past", () => {
    const busy = [
      { start: new Date("2026-10-26T10:00:00Z"), end: new Date("2026-10-26T11:00:00Z") },
      { start: new Date("2026-10-26T10:30:00Z"), end: new Date("2026-10-26T12:00:00Z") }, // overlaps: merged
      { start: new Date("2026-10-26T16:45:00Z"), end: new Date("2026-10-26T18:00:00Z") },
    ];
    const slots = freeSlots(busy, { fromDay: "2026-10-26", toDay: "2026-10-27", dayStart: "09:00", dayEnd: "17:30", minMinutes: 30, timeZone: TZ, notBefore: new Date("2026-10-26T09:10:00Z") });
    expect(slots.map((s) => [s.start.toISOString(), s.end.toISOString()])).toEqual([
      ["2026-10-26T09:15:00.000Z", "2026-10-26T10:00:00.000Z"],
      ["2026-10-26T12:00:00.000Z", "2026-10-26T16:45:00.000Z"],
      ["2026-10-27T09:00:00.000Z", "2026-10-27T17:30:00.000Z"],
    ]);
  });

  it("uses local windows on both sides of the DST change", () => {
    const slots = freeSlots([], { fromDay: "2026-10-24", toDay: "2026-10-26", dayStart: "09:00", dayEnd: "10:00", minMinutes: 60, timeZone: TZ, skipWeekdays: [0] });
    expect(slots.map((s) => s.start.toISOString())).toEqual(["2026-10-24T08:00:00.000Z", "2026-10-26T09:00:00.000Z"]);
  });
});

describe("CalendarService", () => {
  const work = account({ id: "work", vertical: "dms", calendars: ["primary"] });

  function service(google: FakeGoogle) {
    return new CalendarService(parseCalendarAccounts(JSON.stringify([account(), work])), { timeZone: TZ, fetch: google.fetch, now: () => Date.parse("2026-10-23T07:00:00Z") });
  }

  it("lets personal read every account, other verticals only their own, and writes only to the vertical's writable calendars", () => {
    const s = service(new FakeGoogle());
    expect(s.calendars("personal").map((c) => `${c.accountId}/${c.calendarId}:${c.writable}`)).toEqual([
      "google/primary:true",
      "google/family@group.calendar.google.com:false",
      "work/primary:false",
    ]);
    expect(s.calendars("dms").map((c) => c.accountId)).toEqual(["work"]);
    expect(s.calendars("openv")).toEqual([]);
    expect(s.resolveWritable("personal").calendarId).toBe("primary");
    expect(() => s.resolveWritable("personal", undefined, "Family")).toThrow(/read-only/);
    expect(() => s.resolveWritable("personal", "work")).toThrow(/No calendar work/);
    expect(s.resolveWritable("dms").accountId).toBe("work");
  });

  it("merges events across calendars by start, and reports a failing calendar alongside the rest", async () => {
    const google = new FakeGoogle().route("GET", /\/events$/, (c) =>
      c.url.pathname.includes("family")
        ? { status: 500, json: { error: { code: 500, message: "Backend Error" } } }
        : { json: { items: [{ id: `e-${c.headers.authorization}`, summary: "Thing", start: { dateTime: "2026-10-23T09:00:00Z" }, end: { dateTime: "2026-10-23T10:00:00Z" } }] } },
    );
    const { events, errors } = await service(google).listEvents(new Date("2026-10-23T00:00:00Z"), new Date("2026-10-24T00:00:00Z"), { vertical: "personal" });
    expect(events).toHaveLength(2);
    expect(errors).toEqual(["Family: Google Calendar GET /calendars/family%40group.calendar.google.com/events failed: 500 Backend Error"]);
  });

  it("finds free time from free/busy across every readable calendar", async () => {
    const google = new FakeGoogle().route("POST", /\/freeBusy$/, (c) => ({
      json: {
        calendars: Object.fromEntries(
          c.body.items.map((i: { id: string }) => [
            i.id,
            { busy: i.id === "primary" ? [{ start: "2026-10-23T09:00:00Z", end: "2026-10-23T12:00:00Z" }] : [{ start: "2026-10-23T13:00:00Z", end: "2026-10-23T15:00:00Z" }] },
          ]),
        ),
      },
    }));
    const s = service(google);
    const { slots } = await s.findFreeTime({ fromDay: "2026-10-23", toDay: "2026-10-23", minMinutes: 30, dayStart: "09:00", dayEnd: "17:00", vertical: "personal" });
    // 08:00–17:00 local is 08:00Z–16:00Z on this BST day; work and family calendars both block.
    expect(slots.map((s) => [s.start.toISOString().slice(11, 16), s.end.toISOString().slice(11, 16)])).toEqual([
      ["08:00", "09:00"],
      ["12:00", "13:00"],
      ["15:00", "16:00"],
    ]);
    expect(google.apiCalls()).toHaveLength(2); // one free/busy call per account
  });

  it("calls onAuthError when an account's token is revoked", async () => {
    const google = new FakeGoogle();
    google.tokenResponses = [{ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }];
    const seen: string[] = [];
    const s = new CalendarService(parseCalendarAccounts(JSON.stringify([account()])), { timeZone: TZ, fetch: google.fetch, onAuthError: (e) => seen.push(e.accountId) });
    const { errors } = await s.listEvents(new Date(), new Date(Date.now() + 1000));
    expect(errors[0]).toMatch(/Accounts page/);
    expect(seen.length).toBeGreaterThan(0);
  });
});
