import { describe, expect, it } from "vitest";
import { buildAuthUrl, CalendarAuthError, exchangeCode, GoogleCalendarProvider, pkcePair } from "../src";
import { FakeGoogle } from "./fake-google";

const TZ = "Europe/London";
const creds = { clientId: "cid.apps.googleusercontent.com", clientSecret: "client-secret-xyz", refreshToken: "1//refresh-abc" };

function provider(google: FakeGoogle, now = () => Date.parse("2026-10-23T08:00:00Z")) {
  return new GoogleCalendarProvider({
    accountId: "google",
    credentials: creds,
    calendars: [
      { id: "primary", name: "Primary", writable: true, primary: true },
      { id: "family123@group.calendar.google.com", name: "Family", writable: true, primary: false },
    ],
    fetch: google.fetch,
    now,
  });
}

describe("Google Calendar: tokens", () => {
  it("refreshes with the refresh token, caches the access token, and refreshes again near expiry", async () => {
    const google = new FakeGoogle().route("GET", /\/events$/, () => ({ json: { items: [] } }));
    google.tokenResponses = [{ json: { access_token: "at-1", expires_in: 3599 } }, { json: { access_token: "at-2", expires_in: 3599 } }];
    let now = Date.parse("2026-10-23T08:00:00Z");
    const p = provider(google, () => now);
    const range = [new Date("2026-10-23T00:00:00Z"), new Date("2026-10-24T00:00:00Z")] as const;

    await Promise.all([p.listEvents("primary", ...range, TZ), p.listEvents("primary", ...range, TZ)]);
    expect(google.tokenCount).toBe(1); // concurrent calls share one refresh
    const token = google.calls[0]!;
    expect(token.method).toBe("POST");
    expect(token.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(token.body).toEqual({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: "refresh_token" });
    expect(google.apiCalls().every((c) => c.headers.authorization === "Bearer at-1")).toBe(true);

    now += 59 * 60_000; // within a minute of expiry
    await p.listEvents("primary", ...range, TZ);
    expect(google.tokenCount).toBe(2);
    expect(google.apiCalls().at(-1)!.headers.authorization).toBe("Bearer at-2");
  });

  it("retries once with a fresh token when the API says 401", async () => {
    const google = new FakeGoogle().route("GET", /\/events$/, () => ({ json: { items: [] } }));
    google.tokenResponses = [{ json: { access_token: "stale", expires_in: 3599 } }, { json: { access_token: "at-2", expires_in: 3599 } }];
    await provider(google).listEvents("primary", new Date(), new Date(Date.now() + 1000), TZ);
    expect(google.tokenCount).toBe(2);
    expect(google.apiCalls().map((c) => c.headers.authorization)).toEqual(["Bearer stale", "Bearer at-2"]);
  });

  it("explains a revoked or expired refresh token and how to get a new one, without echoing secrets", async () => {
    const google = new FakeGoogle();
    google.tokenResponses = [{ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }];
    const err = await provider(google).listEvents("primary", new Date(), new Date(Date.now() + 1000), TZ).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarAuthError);
    expect(err.accountId).toBe("google");
    expect(err.message).toContain("Token has been expired or revoked");
    expect(err.message).toContain("Reconnect it on the Accounts page");
    expect(err.message).toContain("7 days");
    for (const secret of Object.values(creds)) expect(err.message).not.toContain(secret);
  });
});

describe("Google Calendar: events", () => {
  it("lists events with recurring ones expanded, following pages, mapping times, transparency, responses and reminders", async () => {
    const google = new FakeGoogle().route("GET", /\/calendars\/primary\/events$/, (c) =>
      c.url.searchParams.get("pageToken") === "p2"
        ? {
            json: {
              items: [
                {
                  id: "abc_20261023T140000Z",
                  recurringEventId: "abc",
                  status: "confirmed",
                  summary: "Swimming with Noah",
                  start: { dateTime: "2026-10-23T15:00:00+01:00", timeZone: "Europe/London" },
                  end: { dateTime: "2026-10-23T16:00:00+01:00", timeZone: "Europe/London" },
                  reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
                },
              ],
            },
          }
        : {
            json: {
              nextPageToken: "p2",
              items: [
                { id: "allday", summary: "Half term", start: { date: "2026-10-23" }, end: { date: "2026-10-31" }, transparency: "transparent" },
                {
                  id: "invite",
                  summary: "Supplier call",
                  location: "Zoom",
                  htmlLink: "https://www.google.com/calendar/event?eid=x",
                  start: { dateTime: "2026-10-23T09:30:00+01:00" },
                  end: { dateTime: "2026-10-23T10:00:00+01:00" },
                  attendees: [{ email: "dave@example.com", self: true, responseStatus: "declined" }],
                  reminders: { useDefault: true },
                },
                { id: "gone", status: "cancelled" },
              ],
            },
          },
    );
    const events = await provider(google).listEvents("primary", new Date("2026-10-22T23:00:00Z"), new Date("2026-10-23T23:00:00Z"), TZ);

    const q = google.apiCalls()[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      timeMin: "2026-10-22T23:00:00.000Z",
      timeMax: "2026-10-23T23:00:00.000Z",
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      timeZone: TZ,
    });
    expect(google.apiCalls()[1]!.url.searchParams.get("pageToken")).toBe("p2");
    expect(events.map((e) => e.id)).toEqual(["allday", "invite", "abc_20261023T140000Z"]);
    expect(events[0]).toMatchObject({ allDay: true, start: "2026-10-23", end: "2026-10-31", busy: false, calendarName: "Primary" });
    expect(events[1]).toMatchObject({ start: "2026-10-23T08:30:00.000Z", end: "2026-10-23T09:00:00.000Z", response: "declined", location: "Zoom", reminders: { useDefault: true, overrides: [] } });
    expect(events[2]).toMatchObject({ recurringEventId: "abc", start: "2026-10-23T14:00:00.000Z", reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] } });
  });

  it("queries free/busy for several calendars in one call", async () => {
    const google = new FakeGoogle().route("POST", /\/freeBusy$/, (c) => ({
      json: {
        calendars: Object.fromEntries(
          c.body.items.map((i: { id: string }) => [i.id, { busy: i.id === "primary" ? [{ start: "2026-10-23T09:00:00Z", end: "2026-10-23T10:00:00Z" }] : [] }]),
        ),
      },
    }));
    const busy = await provider(google).freeBusy(["primary", "family123@group.calendar.google.com"], new Date("2026-10-23T00:00:00Z"), new Date("2026-10-24T00:00:00Z"), TZ);
    expect(google.apiCalls()[0]!.body).toEqual({
      timeMin: "2026-10-23T00:00:00.000Z",
      timeMax: "2026-10-24T00:00:00.000Z",
      timeZone: TZ,
      items: [{ id: "primary" }, { id: "family123@group.calendar.google.com" }],
    });
    expect(busy.primary).toEqual([{ start: new Date("2026-10-23T09:00:00Z"), end: new Date("2026-10-23T10:00:00Z") }]);
    expect(busy["family123@group.calendar.google.com"]).toEqual([]);
  });

  it("reports a calendar free/busy can't read", async () => {
    const google = new FakeGoogle().route("POST", /\/freeBusy$/, () => ({ json: { calendars: { primary: { errors: [{ domain: "global", reason: "notFound" }] } } } }));
    await expect(provider(google).freeBusy(["primary"], new Date(), new Date(Date.now() + 1000), TZ)).rejects.toThrow(/Primary.*notFound/);
  });

  it("creates an event anchored in Europe/London with its reminders", async () => {
    const google = new FakeGoogle().route("POST", /\/calendars\/family123%40group\.calendar\.google\.com\/events$|\/calendars\/family123@group\.calendar\.google\.com\/events$/, (c) => ({
      json: { id: "new1", htmlLink: "https://calendar/new1", ...c.body },
    }));
    const event = await provider(google).createEvent("family123@group.calendar.google.com", {
      title: "Dentist",
      start: { at: new Date("2026-10-30T10:00:00Z") },
      end: { at: new Date("2026-10-30T10:30:00Z") },
      location: "High St Dental",
      timeZone: TZ,
      reminders: [{ method: "popup", minutes: 60 }],
    });
    const call = google.apiCalls()[0]!;
    expect(call.url.pathname).toBe("/calendar/v3/calendars/family123%40group.calendar.google.com/events");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({
      summary: "Dentist",
      location: "High St Dental",
      start: { dateTime: "2026-10-30T10:00:00.000Z", timeZone: TZ },
      end: { dateTime: "2026-10-30T10:30:00.000Z", timeZone: TZ },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
    });
    expect(event).toMatchObject({ id: "new1", title: "Dentist", calendarName: "Family", url: "https://calendar/new1", start: "2026-10-30T10:00:00.000Z" });
  });

  it("patches only the given fields, and treats deleting a deleted event as done", async () => {
    const google = new FakeGoogle()
      .route("PATCH", /\/events\/ev1$/, (c) => ({ json: { id: "ev1", summary: "Dentist (moved)", start: { dateTime: "2026-10-30T11:00:00Z" }, end: { dateTime: "2026-10-30T11:30:00Z" }, ...c.body } }))
      .route("DELETE", /\/events\/ev1$/, () => ({ status: 410, json: { error: { code: 410, message: "Resource has been deleted", errors: [{ reason: "deleted" }] } } }));
    const p = provider(google);
    await p.updateEvent("primary", "ev1", { title: "Dentist (moved)", timeZone: TZ });
    expect(google.apiCalls()[0]!.body).toEqual({ summary: "Dentist (moved)" });
    await expect(p.deleteEvent("primary", "ev1")).resolves.toBeUndefined();
  });

  it("surfaces API errors with Google's message and reason", async () => {
    const google = new FakeGoogle().route("POST", /\/events$/, () => ({
      status: 403,
      json: { error: { code: 403, message: "You need to have writer access to this calendar.", errors: [{ reason: "requiredAccessLevel" }] } },
    }));
    await expect(
      provider(google).createEvent("primary", { title: "x", start: { date: "2026-10-30" }, end: { date: "2026-10-31" }, timeZone: TZ }),
    ).rejects.toThrow(/403 You need to have writer access.*requiredAccessLevel/);
  });
});

describe("google:auth helpers", () => {
  it("builds a loopback consent URL with PKCE and offline access", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", challenge, state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: "http://127.0.0.1:5555",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
    });
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("exchanges the code for a refresh token", async () => {
    const google = new FakeGoogle();
    google.tokenResponses = [{ json: { access_token: "at", refresh_token: "1//new", scope: "x" } }];
    const out = await exchangeCode({ clientId: "cid", clientSecret: "sec", code: "4/code", verifier: "v", redirectUri: "http://127.0.0.1:5555" }, google.fetch);
    expect(out.refreshToken).toBe("1//new");
    expect(google.calls[0]!.body).toMatchObject({ grant_type: "authorization_code", code: "4/code", code_verifier: "v", redirect_uri: "http://127.0.0.1:5555" });
  });
});
