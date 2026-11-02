import { describe, expect, it } from "vitest";
import {
  collapsedPayload,
  decideRoute,
  defaultPrefs,
  deviceAccepts,
  heldSummary,
  inferCategory,
  inQuietHours,
  localInstant,
  mergePrefs,
  pushPayload,
  quickBriefingBody,
  quickBriefingDue,
  quietHoursEnd,
  resolveCategory,
} from "../src/notifications/policy";
import { normalize } from "../src/notifications/service";

const LON = "Europe/London";
const at = (s: string) => new Date(s);

describe("notification preferences", () => {
  it("has the documented defaults", () => {
    const p = defaultPrefs(LON);
    expect(p.categories.approval).toEqual({ enabled: true, delivery: "push", sound: true, priority: "high" });
    expect(p.categories.briefing).toMatchObject({ delivery: "push" });
    expect(p.categories.reminder).toMatchObject({ delivery: "push", sound: true });
    expect(p.categories.alert).toMatchObject({ delivery: "push", priority: "urgent" });
    expect(p.categories.digest).toMatchObject({ delivery: "push", sound: false });
    expect(p.categories.social).toMatchObject({ delivery: "digest" });
    expect(p.categories.orders).toMatchObject({ delivery: "digest" });
    expect(p.categories.system).toMatchObject({ delivery: "silent" });
    expect(p.categories.agent).toMatchObject({ delivery: "push" });
    expect(p.quietHours).toEqual({ enabled: true, start: "22:00", end: "07:00", timezone: LON, allowApprovals: false });
    expect(p.quickBriefing.enabled).toBe(false);
  });

  it("applies per-vertical overrides on top of the category", () => {
    const p = mergePrefs(defaultPrefs(LON), { verticals: { "3dpandme": { social: { enabled: false } }, dms: { orders: { delivery: "push", sound: true } } } });
    expect(resolveCategory(p, "social", "3dpandme")).toMatchObject({ enabled: false, delivery: "digest" });
    expect(resolveCategory(p, "social", "dms")).toMatchObject({ enabled: true, delivery: "digest" });
    expect(resolveCategory(p, "orders", "dms")).toEqual({ enabled: true, delivery: "push", sound: true, priority: "normal" });
    expect(resolveCategory(p, "orders", null)).toMatchObject({ delivery: "digest", sound: false });
  });

  it("merges partial patches and ignores invalid ones", () => {
    const base = defaultPrefs(LON);
    const p = mergePrefs(base, { categories: { agent: { sound: false } }, quietHours: { start: "23:30" } });
    expect(p.categories.agent).toEqual({ ...base.categories.agent, sound: false });
    expect(p.quietHours).toMatchObject({ start: "23:30", end: "07:00" });
    expect(mergePrefs(base, { quietHours: { start: "25:00" } })).toEqual(base);
    expect(mergePrefs(base, null)).toEqual(base);
  });

  it("infers a category for older {title, body, url} call sites, else agent", () => {
    expect(inferCategory({ title: "Approve: DMS", url: "/approvals" })).toBe("approval");
    expect(inferCategory({ title: "Morning brief" })).toBe("briefing");
    expect(inferCategory({ title: "Evening wrap-up" })).toBe("briefing");
    expect(inferCategory({ title: "Reminder: bins" })).toBe("reminder");
    expect(inferCategory({ title: "Daily digest, 2026-10-23" })).toBe("digest");
    expect(inferCategory({ title: "Budget reached: DMS" })).toBe("alert");
    expect(inferCategory({ title: "Scheduled post failed", url: "/social" })).toBe("alert");
    expect(inferCategory({ title: "New order S00042" })).toBe("orders");
    expect(inferCategory({ title: "New comment", url: "/social" })).toBe("social");
    expect(inferCategory({ title: "Hello" })).toBe("agent");
    expect(inferCategory({ title: "Approve: x", category: "system" })).toBe("system");
  });

  it("normalises input, keeping {title, body} working", () => {
    expect(normalize({ title: "Hi", body: "There" })).toMatchObject({ title: "Hi", body: "There", category: "agent", priority: undefined, tag: null, actions: [], data: {} });
    // Off-site URLs and junk fields are dropped.
    const n = normalize({ title: "x", body: "y", url: "https://evil.example", priority: "nope" as never, category: "bogus" as never });
    expect(n).toMatchObject({ url: undefined, priority: undefined, category: "agent" });
  });

  it("routes devices by minimum priority", () => {
    expect(deviceAccepts("urgent", "urgent")).toBe(true);
    expect(deviceAccepts("urgent", "high")).toBe(false);
    expect(deviceAccepts("high", "high")).toBe(true);
    expect(deviceAccepts("low", "low")).toBe(true);
    expect(deviceAccepts("normal", "low")).toBe(false);
  });
});

describe("quiet hours", () => {
  const q = defaultPrefs(LON).quietHours;

  it("spans midnight", () => {
    // Summer (BST, UTC+1): 22:00 local is 21:00Z.
    expect(inQuietHours(at("2026-07-01T20:59:00Z"), q)).toBe(false);
    expect(inQuietHours(at("2026-07-01T21:00:00Z"), q)).toBe(true);
    expect(inQuietHours(at("2026-07-01T23:30:00Z"), q)).toBe(true); // 00:30 local
    expect(inQuietHours(at("2026-07-02T05:59:00Z"), q)).toBe(true); // 06:59
    expect(inQuietHours(at("2026-07-02T06:00:00Z"), q)).toBe(false); // 07:00
    // Winter (GMT): local equals UTC.
    expect(inQuietHours(at("2026-01-10T06:59:00Z"), q)).toBe(true);
    expect(inQuietHours(at("2026-01-10T07:00:00Z"), q)).toBe(false);
    expect(inQuietHours(at("2026-01-10T22:00:00Z"), q)).toBe(true);
  });

  it("follows DST changes in Europe/London", () => {
    // Clocks go forward 29 Mar 2026 at 01:00 GMT: 07:00 that morning is 06:00Z.
    expect(inQuietHours(at("2026-03-29T05:59:00Z"), q)).toBe(true);
    expect(inQuietHours(at("2026-03-29T06:00:00Z"), q)).toBe(false);
    // Clocks go back 25 Oct 2026 at 02:00 BST: 07:00 that morning is 07:00Z.
    expect(inQuietHours(at("2026-10-25T06:30:00Z"), q)).toBe(true);
    expect(inQuietHours(at("2026-10-25T07:00:00Z"), q)).toBe(false);
    expect(quietHoursEnd(at("2026-10-24T23:00:00Z"), q).toISOString()).toBe("2026-10-25T07:00:00.000Z");
    expect(quietHoursEnd(at("2026-03-28T23:00:00Z"), q).toISOString()).toBe("2026-03-29T06:00:00.000Z");
    // Held at 22:30 BST: ends at 07:00 the next morning, still BST.
    expect(quietHoursEnd(at("2026-07-01T21:30:00Z"), q).toISOString()).toBe("2026-07-02T06:00:00.000Z");
    expect(localInstant("2026-10-25", "00:00", LON).toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });

  it("handles same-day windows, disabled and empty windows", () => {
    const day = { ...q, start: "13:00", end: "14:00", timezone: "UTC" };
    expect(inQuietHours(at("2026-07-01T13:30:00Z"), day)).toBe(true);
    expect(inQuietHours(at("2026-07-01T14:00:00Z"), day)).toBe(false);
    expect(inQuietHours(at("2026-07-01T23:00:00Z"), { ...q, enabled: false })).toBe(false);
    expect(inQuietHours(at("2026-07-01T23:00:00Z"), { ...q, start: "07:00", end: "07:00" })).toBe(false);
  });
});

describe("routing one notification", () => {
  const prefs = defaultPrefs(LON);
  const noon = at("2026-07-01T11:00:00Z");
  const night = at("2026-07-01T23:00:00Z");
  const route = (category: Parameters<typeof decideRoute>[0]["category"], o: Partial<Parameters<typeof decideRoute>[0]> = {}) =>
    decideRoute({ category, priority: prefs.categories[category].priority, settings: prefs.categories[category], prefs, now: noon, recentPushes: 0, ...o }).kind;

  it("follows on/off and delivery mode", () => {
    expect(route("agent")).toBe("push");
    expect(route("social")).toBe("batched");
    expect(route("orders")).toBe("batched");
    expect(route("system")).toBe("inapp");
    expect(route("digest")).toBe("push");
    expect(route("agent", { settings: { ...prefs.categories.agent, enabled: false } })).toBe("muted");
    // The digest never batches into itself.
    expect(route("digest", { settings: { ...prefs.categories.digest, delivery: "digest" } })).toBe("push");
  });

  it("holds everything but urgent during quiet hours, approvals only if allowed", () => {
    expect(route("agent", { now: night })).toBe("held");
    expect(route("approval", { now: night })).toBe("held");
    expect(route("alert", { now: night })).toBe("push"); // urgent by default
    expect(route("agent", { now: night, priority: "urgent" })).toBe("push");
    const allow = { ...prefs, quietHours: { ...prefs.quietHours, allowApprovals: true } };
    expect(route("approval", { now: night, prefs: allow })).toBe("push");
  });

  it("collapses pushes over the per-category rate limit, except urgent", () => {
    expect(route("agent", { recentPushes: 2 })).toBe("push");
    expect(route("agent", { recentPushes: 3 })).toBe("collapse");
    expect(route("digest", { recentPushes: 5 })).toBe("push");
    expect(route("agent", { recentPushes: 3, priority: "urgent" })).toBe("push");
    expect(route("agent", { recentPushes: 50, prefs: { ...prefs, rateLimit: { perCategory: 0, windowMinutes: 10 } } })).toBe("push");
  });
});

describe("push payloads", () => {
  const base = {
    id: "n1",
    category: "approval" as const,
    priority: "high" as const,
    vertical: "dms",
    title: "Approve: DMS",
    body: "Reply to Bob",
    url: "/approvals/p1",
    tag: "approvals",
    actions: [
      { action: "approve", title: "Approve" },
      { action: "reject", title: "Reject" },
    ],
    data: { proposalId: "p1", pendingApprovals: 3 },
  };

  it("carries tag, renotify, silent, actions and the badge count", () => {
    const p = pushPayload(base, true, 4);
    expect(p).toMatchObject({ tag: "approvals", renotify: true, silent: false, unread: 4, url: "/approvals/p1" });
    expect(p.body).toBe("Reply to Bob\n+2 more waiting");
    expect(p.actions.map((a) => a.action)).toEqual(["approve", "reject"]);
    expect(p.data).toMatchObject({ proposalId: "p1", notificationId: "n1" });
    // Low priority with a tag replaces quietly; no sound means silent.
    expect(pushPayload({ ...base, category: "digest", priority: "low", data: {} }, false)).toMatchObject({ renotify: false, silent: true });
    expect(pushPayload({ ...base, tag: null }, true).renotify).toBe(false);
    expect(pushPayload({ ...base, priority: "urgent" }, true).requireInteraction).toBe(true);
  });

  it("summarises collapsed, held and quick-briefing notifications", () => {
    expect(collapsedPayload("agent", 3, "Latest thing", true)).toMatchObject({
      title: "Agent messages: and 3 more",
      tag: "more-agent",
      renotify: false,
      silent: true,
    });
    expect(collapsedPayload("agent", 1, "x", true).silent).toBe(false);
    const held = heldSummary([
      { title: "A", category: "agent" },
      { title: "B", category: "agent" },
      { title: "C", category: "reminder" },
    ]);
    expect(held.title).toBe("3 notifications during quiet hours");
    expect(held.body).toBe("2 agent messages, 1 reminders\n• A\n• B\n• C");
    expect(held.tag).toBe("quiet-summary");
    expect(
      quickBriefingBody({ pendingApprovals: 2, tasks: { total: 5, done: 3, failed: 1, open: 1 }, costUsd: 1.234, budgetUsd: 10, unread: 1 }),
    ).toBe("2 approvals waiting\nTasks today: 5 (3 done, 1 failed, 1 open)\nSpent today: $1.23 of $10.00\n1 unread notification");
  });

  it("knows when the quick briefing is due", () => {
    const p = mergePrefs(defaultPrefs(LON), { quickBriefing: { enabled: true, time: "07:30" } });
    expect(quickBriefingDue(at("2026-07-01T06:29:00Z"), p)).toBe(false); // 07:29 BST
    expect(quickBriefingDue(at("2026-07-01T06:30:00Z"), p)).toBe(true);
    expect(quickBriefingDue(at("2026-07-01T07:29:00Z"), p)).toBe(true);
    expect(quickBriefingDue(at("2026-07-01T07:30:00Z"), p)).toBe(false);
    expect(quickBriefingDue(at("2026-07-01T06:30:00Z"), defaultPrefs(LON))).toBe(false); // off by default
  });
});
