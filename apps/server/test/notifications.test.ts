import { VerticalRegistry } from "@cc/verticals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PushTransport } from "../src/push";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

class FakeTransport implements PushTransport {
  readonly publicKey = "test-public-key";
  readonly sent: { endpoint: string; payload: any; options: any }[] = [];
  gone = new Set<string>();
  async send(subscription: any, payload: string, options: any) {
    if (this.gone.has(subscription.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
    this.sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
  }
}

const sub = (name: string) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: "p", auth: "a" } });
const NOON = new Date("2026-07-01T11:00:00Z"); // 12:00 BST
const NIGHT = new Date("2026-07-01T22:30:00Z"); // 23:30 BST

describe.skipIf(!DB_URL)("notifications (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const transport = new FakeTransport();
  let now = NOON;
  const notifications = () => ctx.server.notifications;
  const reset = async () => {
    await ctx.server.store.pool.query("delete from notifications; delete from notification_prefs; delete from notification_runs");
    transport.sent.length = 0;
    ctx.notifier.sent.length = 0;
    now = new Date(now.getTime() + 3_600_000); // a fresh rate window
  };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { pushTransport: transport, notificationClock: () => now } });
    const phone = await ctx.api("/api/notifications/devices", {
      method: "POST",
      json: { subscription: sub("phone"), name: "Dave's phone" },
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
    });
    expect(phone.status).toBe(201);
    expect(phone.body).toMatchObject({ name: "Dave's phone", platform: "ios", minPriority: "low" });
    await ctx.api("/api/notifications/devices", { method: "POST", json: { subscription: sub("desktop"), name: "Desktop" } });
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(async () => {
    now = NOON;
    await reset();
  });

  it("keeps notify({title, body}) working: stored as agent and pushed to every device", async () => {
    await ctx.server.actions; // server wired
    await notifications().notify({ title: "Hello", body: "World" });
    const { body } = await ctx.api("/api/notifications");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ title: "Hello", body: "World", category: "agent", priority: "normal", status: "sent", readAt: null });
    expect(body.unread).toBe(1);
    expect(transport.sent.map((s) => s.endpoint).sort()).toEqual(["https://push.example/desktop", "https://push.example/phone"]);
    expect(transport.sent[0]!.payload).toMatchObject({ title: "Hello", category: "agent", silent: false, unread: 1 });
  });

  it("serves the inbox: filter, unread count, read, read-all", async () => {
    await notifications().notify({ title: "A", body: "a", category: "reminder" });
    await notifications().notify({ title: "B", body: "b", category: "agent" });
    await notifications().notify({ title: "C", body: "c", category: "system" });
    expect((await ctx.api("/api/notifications/unread-count")).body).toEqual({ unread: 3 });
    const reminders = (await ctx.api("/api/notifications?category=reminder")).body.items;
    expect(reminders.map((n: any) => n.title)).toEqual(["A"]);
    expect((await ctx.api("/api/notifications?category=nope")).status).toBe(400);

    const read = await ctx.api(`/api/notifications/${reminders[0].id}/read`, { method: "POST" });
    expect(read.body.unread).toBe(2);
    expect(read.body.notification.readAt).not.toBeNull();
    expect((await ctx.api(`/api/notifications/${reminders[0].id}`)).body.title).toBe("A");
    expect((await ctx.api("/api/notifications/00000000-0000-0000-0000-000000000000/read", { method: "POST" })).status).toBe(404);
    expect((await ctx.api("/api/notifications/not-a-uuid")).status).toBe(404);
    expect((await ctx.api("/api/notifications?unread=1")).body.items).toHaveLength(2);

    expect((await ctx.api("/api/notifications/read-all", { method: "POST", json: { category: "system" } })).body).toEqual({ changed: 1, unread: 1 });
    expect((await ctx.api("/api/notifications/read-all", { method: "POST" })).body).toEqual({ changed: 1, unread: 0 });
    // System is in-app only by default: stored, never pushed.
    expect(transport.sent.filter((s) => s.payload.title === "C")).toHaveLength(0);
  });

  it("needs auth", async () => {
    expect((await ctx.api("/api/notifications", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("reads and updates preferences", async () => {
    const got = (await ctx.api("/api/notifications/prefs")).body;
    expect(got.prefs.categories.social.delivery).toBe("digest");
    expect(got.categories).toContain("briefing");
    const put = await ctx.api("/api/notifications/prefs", { method: "PUT", json: { categories: { agent: { sound: false } }, quietHours: { start: "23:00" } } });
    expect(put.body.prefs.categories.agent).toMatchObject({ sound: false, delivery: "push" });
    expect(put.body.prefs.quietHours).toMatchObject({ start: "23:00", end: "07:00" });
    expect((await ctx.api("/api/notifications/prefs", { method: "PUT", json: { quietHours: { start: "9pm" } } })).status).toBe(400);
    await notifications().notify({ title: "Quiet", body: "x" });
    expect(transport.sent[0]!.payload.silent).toBe(true);
  });

  it("mutes per vertical", async () => {
    await ctx.api("/api/notifications/prefs", { method: "PUT", json: { verticals: { dms: { agent: { enabled: false } } } } });
    await notifications().notify({ title: "From DMS", body: "x", vertical: "dms" });
    await notifications().notify({ title: "From OpenV", body: "x", vertical: "openv" });
    const items = (await ctx.api("/api/notifications")).body.items;
    expect(items.find((n: any) => n.title === "From DMS")).toMatchObject({ status: "muted" });
    expect(items.find((n: any) => n.title === "From DMS").readAt).not.toBeNull();
    expect(transport.sent.map((s) => s.payload.title)).toEqual(["From OpenV", "From OpenV"]);
  });

  it("holds during quiet hours, lets urgent through, then releases one summary", async () => {
    now = NIGHT;
    await notifications().notify({ title: "Agent note", body: "x" });
    await notifications().notify({ title: "Remember the bins", body: "x", category: "reminder" });
    await notifications().notify({ title: "Server down", body: "x", category: "alert" });
    expect(transport.sent.map((s) => s.payload.title)).toEqual(["Server down", "Server down"]);
    const held = (await ctx.api("/api/notifications")).body.items.filter((n: any) => n.status === "held");
    expect(held).toHaveLength(2);
    expect(held[0].data.heldUntil).toBe("2026-07-02T06:00:00.000Z");

    transport.sent.length = 0;
    now = new Date("2026-07-02T05:59:00Z");
    await notifications().tick();
    expect(transport.sent).toHaveLength(0);
    now = new Date("2026-07-02T06:00:00Z");
    await notifications().tick();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]!.payload).toMatchObject({ title: "2 notifications during quiet hours", tag: "quiet-summary" });
    expect(transport.sent[0]!.payload.body).toContain("• Agent note");
    await notifications().tick();
    expect(transport.sent).toHaveLength(2);
    const statuses = (await ctx.api("/api/notifications")).body.items.map((n: any) => n.status).sort();
    expect(statuses).toEqual(["released", "released", "sent"]);
  });

  it("rate-limits per category and collapses extras into one 'and N more' push", async () => {
    for (let i = 1; i <= 5; i++) await notifications().notify({ title: `Agent ${i}`, body: "x" });
    await notifications().notify({ title: "A reminder", body: "x", category: "reminder" });
    const phone = transport.sent.filter((s) => s.endpoint.endsWith("phone")).map((s) => s.payload);
    expect(phone.map((p) => p.title)).toEqual(["Agent 1", "Agent 2", "Agent 3", "Agent messages: and 1 more", "Agent messages: and 2 more", "A reminder"]);
    expect(phone[4]).toMatchObject({ tag: "more-agent", renotify: false, silent: true, body: "Latest: Agent 5" });
    // After the window, pushes resume.
    now = new Date(now.getTime() + 11 * 60_000);
    await notifications().notify({ title: "Agent 6", body: "x" });
    expect(transport.sent.at(-1)!.payload.title).toBe("Agent 6");
  });

  it("batches social and orders into the next digest push", async () => {
    await notifications().notify({ title: "New comment", body: "x", category: "social", vertical: "3dpandme" });
    await notifications().notify({ title: "New order S1", body: "x", category: "orders", vertical: "dms" });
    expect(transport.sent).toHaveLength(0);
    // Something for the digest to report.
    await ctx.server.actions.propose({ vertical: "dms", actionType: "brain.journal", summary: "Log it", payload: { text: "x" } });
    transport.sent.length = 0;
    await ctx.server.digests.deliver();
    const digest = transport.sent.find((s) => s.payload.category === "digest")!.payload;
    expect(digest.body).toContain("Also: 1 social, 1 orders (in Notifications)");
    expect(digest).toMatchObject({ silent: true, tag: "digest:dms" });
    const items = (await ctx.api("/api/notifications")).body.items;
    expect(items.filter((n: any) => n.status === "digested")).toHaveLength(2);
  });

  it("sends call sites with the right categories", async () => {
    const p = await ctx.server.actions.propose({ vertical: "dms", actionType: "brain.journal", summary: "Log the stock", payload: { text: "x" } });
    expect(ctx.notifier.sent.at(-1)).toMatchObject({
      title: "Approve: Desktop Machine Shop",
      category: "approval",
      priority: "high",
      tag: "approvals",
      url: `/approvals/${p.id}`,
      data: { proposalId: p.id },
    });
    const push = transport.sent.find((s) => s.payload.category === "approval")!;
    expect(push.payload.actions.map((a: any) => a.action)).toEqual(["approve", "reject"]);
    expect(push.payload).toMatchObject({ tag: "approvals", renotify: true });
    expect(push.options).toMatchObject({ urgency: "high", topic: "approvals" });
    // Deciding it marks the request read.
    await ctx.server.actions.approve(p.id);
    const approval = (await ctx.api("/api/notifications?category=approval")).body.items[0];
    expect(approval.readAt).not.toBeNull();

    const dms = new VerticalRegistry().require("dms");
    await ctx.server.budget.alert(dms, { scope: "vertical", limitUsd: 1, spentUsd: 2 });
    expect(ctx.notifier.sent.at(-1)).toMatchObject({ category: "alert", priority: "high", vertical: "dms" });

    await ctx.server.digests.deliver();
    expect(ctx.notifier.sent.at(-1)).toMatchObject({ category: "digest", priority: "normal" });
  });

  it("lets the notify executor pick a category, defaulting to agent", async () => {
    const brief = await ctx.server.actions.propose({
      vertical: "personal",
      actionType: "notify",
      summary: "Brief",
      payload: { title: "Morning brief", body: "1. Ship\n2. Approve", category: "briefing" },
    });
    expect(brief.status).toBe("executed");
    const stored = (await ctx.api("/api/notifications?category=briefing")).body.items[0];
    expect(stored).toMatchObject({ title: "Morning brief", vertical: "personal", url: `/briefing/${stored.id}` });

    await ctx.server.actions.propose({ vertical: "personal", actionType: "notify", summary: "x", payload: { title: "Hi", body: "b" } });
    expect(ctx.notifier.sent.at(-1)).toMatchObject({ category: "agent" });
    // Agents can't pose as approvals or break quiet hours.
    await ctx.server.actions.propose({ vertical: "personal", actionType: "notify", summary: "x", payload: { title: "Hi", body: "b", category: "approval", priority: "urgent" } });
    expect(ctx.notifier.sent.at(-1)).toMatchObject({ category: "agent", priority: undefined });
    await ctx.server.actions.propose({ vertical: "personal", actionType: "notify", summary: "x", payload: { title: "Hi", body: "b", category: "alert" } });
    expect(ctx.notifier.sent.at(-1)).toMatchObject({ category: "alert", priority: "high" });
  });

  it("manages devices: rename, routing, test pushes, removal", async () => {
    const devices = (await ctx.api("/api/notifications/devices")).body.devices;
    const phone = devices.find((d: any) => d.name === "Dave's phone");
    const renamed = await ctx.api(`/api/notifications/devices/${phone.id}`, { method: "PATCH", json: { name: "Phone", minPriority: "urgent" } });
    expect(renamed.body).toMatchObject({ name: "Phone", minPriority: "urgent" });

    await notifications().notify({ title: "Normal", body: "x" });
    await notifications().notify({ title: "Urgent", body: "x", category: "alert" });
    expect(transport.sent.filter((s) => s.endpoint.endsWith("phone")).map((s) => s.payload.title)).toEqual(["Urgent"]);
    expect(transport.sent.filter((s) => s.endpoint.endsWith("desktop"))).toHaveLength(2);

    transport.sent.length = 0;
    const t = await ctx.api("/api/notifications/test", { method: "POST", json: { deviceId: phone.id } });
    expect(t.status).toBe(201);
    expect(transport.sent.map((s) => s.endpoint)).toEqual(["https://push.example/phone"]);
    transport.sent.length = 0;
    await ctx.api("/api/notifications/test", { method: "POST", json: { category: "reminder" } });
    expect(transport.sent.map((s) => s.payload.title)).toEqual(["Test: Reminders"]); // the phone takes urgent only
    expect((await ctx.api("/api/notifications/test", { method: "POST", json: { deviceId: "nope" } })).status).toBe(404);
    const list = (await ctx.api("/api/notifications/devices")).body.devices;
    expect(list.find((d: any) => d.name === "Phone").lastSuccessAt).not.toBeNull();

    await ctx.api(`/api/notifications/devices/${phone.id}`, { method: "PATCH", json: { minPriority: "low" } });
    // An expired subscription is dropped on the next send.
    transport.gone.add("https://push.example/desktop");
    await notifications().notify({ title: "x", body: "y" });
    transport.gone.clear();
    expect((await ctx.api("/api/notifications/devices")).body.devices.map((d: any) => d.name)).toEqual(["Phone"]);
    expect((await ctx.api(`/api/notifications/devices/${phone.id}`, { method: "DELETE" })).body).toEqual({ ok: true });
    expect((await ctx.api("/api/notifications/devices")).body.devices).toEqual([]);
    // Back for later tests.
    await ctx.api("/api/notifications/devices", { method: "POST", json: { subscription: sub("phone"), name: "Dave's phone" } });
  });

  it("sends the quick briefing once a day at its time, only when enabled", async () => {
    now = new Date("2026-07-03T06:30:00Z"); // 07:30 BST
    await notifications().tick();
    expect(transport.sent).toHaveLength(0);
    await ctx.api("/api/notifications/prefs", { method: "PUT", json: { quickBriefing: { enabled: true, time: "07:30" } } });
    await notifications().tick();
    await notifications().tick();
    const briefs = transport.sent.filter((s) => s.payload.title === "Quick briefing");
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.payload.body).toMatch(/approvals? waiting\nTasks today: \d+/);
    expect(briefs[0]!.payload.url).toMatch(/^\/briefing\//);
  });
});
