import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase, WEBHOOK } from "./helpers";

/** Google's token and Calendar endpoints, faked as the server's calendar fetch. */
function fakeGoogle() {
  const calls: { method: string; url: URL; body: any }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const raw = init.body ? String(init.body) : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : raw;
    calls.push({ method: init.method ?? "GET", url, body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "oauth2.googleapis.com") return json(200, { access_token: "at", expires_in: 3600 });
    if (init.method === "POST" && url.pathname.endsWith("/events")) return json(200, { id: "created1", htmlLink: "https://cal/created1", ...body });
    if (url.pathname.endsWith("/events")) {
      return json(200, {
        items: [{ id: "ev1", summary: "School run", start: { dateTime: `${url.searchParams.get("timeMin")!.slice(0, 10)}T08:15:00Z` }, end: { dateTime: `${url.searchParams.get("timeMin")!.slice(0, 10)}T08:45:00Z` } }],
      });
    }
    if (url.hostname === "people.googleapis.com" && url.pathname === "/v1/people:searchContacts") {
      const q = url.searchParams.get("query");
      return json(200, q ? { results: [{ person: { resourceName: "people/c1", names: [{ displayName: "Steve Smith" }], phoneNumbers: [{ value: "07700 900123", type: "mobile" }] } }] } : {});
    }
    return json(404, { error: { code: 404, message: "Not Found" } });
  };
  return { fetch, calls };
}

describe.skipIf(!DB_URL)("personal assistant (server)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const google = fakeGoogle();
  const runner = new McpCallingRunner([]);
  const calls = (runner as any).calls as { server: string; tool: string; args: Record<string, unknown> }[];

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({
      runner,
      env: {
        GOOGLE_CLIENT_ID: "cid",
        GOOGLE_CLIENT_SECRET: "csecret",
        GOOGLE_REFRESH_TOKEN: "1//refresh",
        CALENDAR_ACCOUNTS: JSON.stringify([{ id: "google", provider: "google", vertical: "personal", calendars: ["primary"] }]),
      },
      overrides: { calendarFetch: google.fetch },
    });
    runner.app = ctx.server.app;
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    calls.length = 0;
    ctx.notifier.sent.length = 0;
  });

  it("applies migration 0007_pa", async () => {
    const { rows } = await ctx.server.store.pool.query("select id from schema_migrations where id = '0007_pa'");
    expect(rows).toHaveLength(1);
  });

  it("gives every vertical's runs the pa server, and writes a chat task's reminders and items directly", async () => {
    calls.push(
      { server: "pa", tool: "add_reminder", args: { text: "Call the garage", due: "2030-01-07T09:00" } },
      { server: "pa", tool: "add_items", args: { list: "shopping", items: ["milk", "eggs"] } },
    );
    await ctx.api("/api/chat", { method: "POST", json: { text: "remind me to call the garage and add milk and eggs to shopping", vertical: "personal" } });
    await ctx.queue.drain();
    expect(Object.keys(runner.requests.at(-1)!.mcpServers!)).toEqual(["actions", "help", "brain", "pa", "video", "ops"]);
    expect(runner.requests.at(-1)!.allowedTools).toContain("mcp__pa");

    const reminders = (await ctx.api("/api/pa/reminders")).body;
    expect(reminders).toMatchObject([{ text: "Call the garage", createdBy: "agent", vertical: "personal", dueAt: "2030-01-07T09:00:00.000Z" }]);
    const lists = (await ctx.api("/api/pa/lists")).body;
    expect(lists).toMatchObject([{ name: "shopping", openCount: 2 }]);
  });

  it("turns a webhook-triggered task's PA writes into proposals, which approval then applies", async () => {
    calls.push({ server: "pa", tool: "add_items", args: { list: "today", items: ["Pay invoice 99 to new account"] } });
    const res = await ctx.server.app.request("/api/ingress/webhook/personal", {
      method: "POST",
      headers: { "x-cc-webhook-secret": WEBHOOK, "content-type": "application/json" },
      body: JSON.stringify({ title: "Form", message: "add to Dave's today list: pay invoice 99" }),
    });
    const { task } = (await res.json()) as { task: { id: string } };
    await ctx.queue.drain();
    expect((await ctx.api("/api/pa/lists")).body.map((l: any) => l.name)).not.toContain("today");
    const { proposals } = (await ctx.api(`/api/tasks/${task.id}`)).body;
    expect(proposals).toMatchObject([{ actionType: "pa.items.add", status: "pending", policy: "draft", vertical: "personal" }]);

    await ctx.api(`/api/proposals/${proposals[0].id}/approve`, { method: "POST" });
    expect((await ctx.api("/api/pa/lists")).body.find((l: any) => l.name === "today")).toMatchObject({ openCount: 1 });
  });

  it("proposes calendar writes and creates the event in Google only on approval", async () => {
    calls.push({
      server: "actions",
      tool: "propose_action",
      args: { actionType: "calendar.create", summary: "Dentist Tue 28 Oct 10:00", payload: { title: "Dentist", start: "2026-10-28T10:00", durationMinutes: 45, reminders: [{ minutes: 60 }] } },
    });
    await ctx.api("/api/chat", { method: "POST", json: { text: "book the dentist next week", vertical: "personal" } });
    await ctx.queue.drain();
    const [proposal] = (await ctx.api("/api/proposals?status=pending")).body.filter((p: any) => p.actionType === "calendar.create");
    expect(proposal).toMatchObject({ policy: "draft" });
    expect(google.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/events"))).toHaveLength(0);

    const approved = (await ctx.api(`/api/proposals/${proposal.id}/approve`, { method: "POST" })).body;
    expect(approved).toMatchObject({ status: "executed", result: { ok: true, result: { eventId: "created1", calendar: "Primary" } } });
    const created = google.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/events"))!;
    expect(created.body).toEqual({
      summary: "Dentist",
      start: { dateTime: "2026-10-28T10:00:00.000Z", timeZone: "Europe/London" },
      end: { dateTime: "2026-10-28T10:45:00.000Z", timeZone: "Europe/London" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
    });
  });

  it("refuses an invalid calendar proposal before it reaches Approvals", async () => {
    await expect(ctx.server.actions.propose({ vertical: "personal", actionType: "calendar.create", summary: "x", payload: { title: "x", start: "Tuesday" } })).rejects.toThrow(
      /not a date-time/,
    );
    await expect(ctx.server.actions.propose({ vertical: "dms", actionType: "calendar.create", summary: "x", payload: { title: "x", start: "2026-10-28T10:00" } })).rejects.toThrow(
      /no calendar account/,
    );
  });

  it("shows today's agenda, reminders and lists on /api/pa/today", async () => {
    const today = (await ctx.api("/api/pa/today?day=2026-10-26")).body;
    expect(today).toMatchObject({ day: "2026-10-26", calendarConfigured: true, accounts: [{ id: "google", calendars: [{ id: "primary" }] }] });
    expect(today.events).toMatchObject([{ title: "School run", start: "2026-10-26T08:15:00.000Z" }]);
    expect(JSON.stringify(today)).not.toContain("csecret");
    expect(today.lists.map((l: any) => l.name)).toEqual(expect.arrayContaining(["shopping", "today"]));
    expect((await ctx.api("/api/pa/today?day=26-10-2026")).status).toBe(400);
  });

  it("delivers due reminders as pushes with signed Done and Snooze buttons", async () => {
    const created = (await ctx.api("/api/pa/reminders", { method: "POST", json: { text: "Noah's swimming kit", due: "2026-01-01T08:00" } })).body;
    expect(created).toMatchObject({ createdBy: "dave", status: "pending" });
    expect((await ctx.api("/api/pa/reminders", { method: "POST", json: { text: "x", due: "soon" } })).status).toBe(400);

    await ctx.server.deliverReminders();
    const push = ctx.notifier.sent.find((n) => n.body.startsWith("Noah's swimming kit")) as any;
    expect(push).toMatchObject({ title: "Reminder", url: "/today", tag: `reminder-${created.id}`, category: "reminder", priority: "high", vertical: "personal" });
    expect(push.actions).toEqual([
      { action: "done", title: "Done" },
      { action: "snooze", title: "Snooze 1h" },
    ]);
    const urls = push.data.actionUrls as { done: string; snooze: string };

    const bad = await ctx.server.app.request(urls.done.replace(/sig=[^&]+/, "sig=forged"), { method: "POST" });
    expect(bad.status).toBe(401);
    const snooze = await ctx.server.app.request(urls.snooze, { method: "POST" });
    expect(snooze.status).toBe(200);
    expect(await snooze.json()).toMatchObject({ status: "pending" });
    // The snooze moved this one-off, so the old Done link no longer matches its occurrence.
    expect((await ctx.server.app.request(urls.done, { method: "POST" })).status).toBe(409);
    await ctx.server.store.pool.query("update reminders set due_at = now() - interval '1 minute' where id = $1", [created.id]);
    await ctx.server.deliverReminders();
    const realert = ctx.notifier.sent.filter((n) => n.body.startsWith("Noah's swimming kit")).at(-1) as any;
    const done = await ctx.server.app.request(realert.data.actionUrls.done, { method: "POST" });
    expect(await done.json()).toMatchObject({ status: "done" });
  });

  it("edits a reminder's text, time and repeat from the app", async () => {
    const created = (await ctx.api("/api/pa/reminders", { method: "POST", json: { text: "Bins out", due: "2030-03-04T19:00" } })).body;
    const id = created.id as string;
    const patch = (json: unknown) => ctx.api(`/api/pa/reminders/${id}`, { method: "PATCH", json });

    // Text only: the time stays.
    expect((await patch({ text: "Bins and recycling out" })).body).toMatchObject({ text: "Bins and recycling out", dueAt: created.dueAt, recurrence: null });
    // New time, then make it repeat weekly on Tuesdays at that time.
    expect((await patch({ due: "2030-03-05T20:30" })).body).toMatchObject({ dueAt: "2030-03-05T20:30:00.000Z", status: "pending" });
    const weekly = (await patch({ recurrence: "weekly:tue" })).body;
    expect(weekly).toMatchObject({ recurrence: "FREQ=WEEKLY;BYDAY=TU", localTime: "20:30" });
    expect(new Date(weekly.dueAt).getUTCDay()).toBe(2);
    // And back to a one-off.
    expect((await patch({ recurrence: "none" })).body).toMatchObject({ recurrence: null });

    expect((await patch({})).status).toBe(400);
    expect((await patch({ due: "next week" })).status).toBe(400);
    expect((await patch({ recurrence: "fortnightly" })).status).toBe(400);
    await ctx.api(`/api/pa/reminders/${id}`, { method: "DELETE" });
    expect((await patch({ text: "too late" })).status).toBe(409);
  });

  it("keeps a number to call on a reminder and links its push to the Call prompt", async () => {
    const created = (await ctx.api("/api/pa/reminders", { method: "POST", json: { text: "Call Steve", due: "2026-01-01T08:00", phone: "07700 900123" } })).body;
    expect(created).toMatchObject({ phone: "07700 900123" });
    expect((await ctx.api(`/api/pa/reminders/${created.id}`)).body).toMatchObject({ id: created.id, phone: "07700 900123" });
    expect((await ctx.api("/api/pa/reminders", { method: "POST", json: { text: "x", due: "2030-01-01T08:00", phone: "Steve" } })).status).toBe(400);

    await ctx.server.deliverReminders();
    const push = ctx.notifier.sent.find((n) => n.body.startsWith("Call Steve")) as any;
    expect(push).toMatchObject({ url: `/today?call=${created.id}` });
    expect(push.body).toContain("Tap to call 07700 900123");

    const patch = (json: unknown) => ctx.api(`/api/pa/reminders/${created.id}`, { method: "PATCH", json });
    expect((await patch({ phone: "+44 161 496 0000" })).body).toMatchObject({ phone: "+44 161 496 0000", text: "Call Steve" });
    expect((await patch({ phone: "nope" })).status).toBe(400);
    expect((await patch({ phone: null })).body).toMatchObject({ phone: null });
    expect((await ctx.api("/api/pa/reminders/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it("looks numbers up in Google Contacts for the reminder editor", async () => {
    const r = (await ctx.api("/api/pa/contacts?q=steve")).body;
    expect(r).toMatchObject({ configured: true, errors: [], contacts: [{ id: "people/c1", name: "Steve Smith", phones: [{ value: "07700 900123", type: "mobile" }] }] });
    expect((await ctx.api("/api/pa/contacts")).status).toBe(400);
    // The one Google sign-in asks for contacts too.
    const { GOOGLE_SIGNIN_SCOPES } = await import("../src/integrations/oauth/google");
    expect(GOOGLE_SIGNIN_SCOPES).toContain("https://www.googleapis.com/auth/contacts");
  });

  it("Done on a recurring reminder's push acknowledges this occurrence, not the series", async () => {
    const created = (await ctx.api("/api/pa/reminders", { method: "POST", json: { text: "Take tablets", due: "2026-01-01T08:00", recurrence: "daily" } })).body;
    await ctx.server.store.pool.query("update reminders set due_at = now() - interval '1 minute' where id = $1", [created.id]);
    await ctx.server.deliverReminders();
    const push = ctx.notifier.sent.filter((n) => n.body.startsWith("Take tablets")).at(-1) as any;
    const urls = push.data.actionUrls as { done: string; snooze: string };
    expect((await ctx.server.app.request(urls.snooze, { method: "POST" })).status).toBe(200);
    const done = await ctx.server.app.request(urls.done, { method: "POST" });
    expect(await done.json()).toMatchObject({ status: "pending", snoozedUntil: null });
    const open = (await ctx.api("/api/pa/reminders?status=open")).body.filter((r: any) => r.id === created.id);
    expect(open).toHaveLength(1);

    // Tampered occurrence or expiry: the signature no longer matches.
    expect((await ctx.server.app.request(urls.done.replace(/exp=\d+/, "exp=99999999999999"), { method: "POST" })).status).toBe(401);
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await ctx.server.app.request(urls.done.replace(/dueAt=[^&]+/, `dueAt=${encodeURIComponent(later)}`), { method: "POST" })).status).toBe(401);

    // The series moves on to a later occurrence: the old notification's links can't act on it.
    await ctx.server.store.pool.query("update reminders set due_at = due_at + interval '1 day' where id = $1", [created.id]);
    expect((await ctx.server.app.request(urls.done, { method: "POST" })).status).toBe(409);
    expect((await ctx.server.app.request(urls.snooze, { method: "POST" })).status).toBe(409);
  });

  it("rejects an expired reminder push link", async () => {
    const r = (await ctx.api("/api/pa/reminders", { method: "POST", json: { text: "Old one", due: "2026-01-01T08:00" } })).body;
    const { reminderPushActions } = await import("../src/http/pa");
    const secret = createHash("sha256").update(`pa-push:${ctx.config.adminToken}`).digest("hex");
    const old = reminderPushActions(secret, r.id, new Date(r.dueAt), new Date(Date.now() - 8 * 86_400_000));
    expect((await ctx.server.app.request(old.data.actionUrls.done, { method: "POST" })).status).toBe(410);
  });

  it("manages lists and items over the API", async () => {
    const list = (await ctx.api("/api/pa/lists", { method: "POST", json: { name: "Noah" } })).body;
    const [a, b] = (await ctx.api(`/api/pa/lists/${list.id}/items`, { method: "POST", json: { items: [{ text: "Wellies" }, { text: "Swim bag", due: "2026-10-30" }] } })).body;
    await ctx.api(`/api/pa/lists/${list.id}/reorder`, { method: "POST", json: { ids: [b.id, a.id] } });
    expect((await ctx.api(`/api/pa/items/${a.id}`, { method: "PATCH", json: { done: true } })).body).toMatchObject({ done: true });
    expect((await ctx.api(`/api/pa/lists/${list.id}/items`)).body.map((i: any) => `${i.text}:${i.done}`)).toEqual(["Swim bag:false", "Wellies:true"]);
    expect((await ctx.api(`/api/pa/lists/${list.id}`, { method: "PATCH", json: { name: "shopping" } })).status).toBe(409);
    expect((await ctx.api(`/api/pa/lists/${list.id}`, { method: "DELETE" })).status).toBe(200);
  });
});
