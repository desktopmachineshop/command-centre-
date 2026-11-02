import {
  CATEGORY_LABELS,
  type CategoryPrefs,
  CategoryPrefs as CategoryPrefsSchema,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITIES,
  type NotificationCategory,
  type NotificationInput,
  type NotificationPrefs,
  NotificationPrefs as NotificationPrefsSchema,
  type NotificationPriority,
  type StoredNotification,
} from "@cc/core";
import { z } from "zod";

/**
 * Pure notification rules: defaults, preference resolution, category
 * inference, quiet hours (in a timezone, across midnight and DST), rate
 * limiting and the summaries pushed for held, collapsed and batched
 * notifications. NotificationService applies them; tests call them directly.
 */

export const DEFAULT_USER = "default";

const isCategory = (v: unknown): v is NotificationCategory => NOTIFICATION_CATEGORIES.includes(v as NotificationCategory);
const isPriority = (v: unknown): v is NotificationPriority => NOTIFICATION_PRIORITIES.includes(v as NotificationPriority);
export { isCategory, isPriority };

/** The defaults: approvals, briefings, reminders, alerts, RFQs and supplier replies push; digests push quietly; social and orders wait for the digest; system stays in the app. */
export function defaultPrefs(timezone = "Europe/London"): NotificationPrefs {
  const c = (delivery: CategoryPrefs["delivery"], sound: boolean, priority: NotificationPriority): CategoryPrefs => ({
    enabled: true,
    delivery,
    sound,
    priority,
  });
  return {
    categories: {
      approval: c("push", true, "high"),
      briefing: c("push", false, "normal"),
      reminder: c("push", true, "high"),
      alert: c("push", true, "urgent"),
      digest: c("push", false, "low"),
      social: c("digest", false, "low"),
      orders: c("digest", false, "normal"),
      quotes: c("push", true, "high"),
      system: c("silent", false, "low"),
      agent: c("push", true, "normal"),
    },
    verticals: {},
    quietHours: { enabled: true, start: "22:00", end: "07:00", timezone, allowApprovals: false },
    rateLimit: { perCategory: 3, windowMinutes: 10 },
    quickBriefing: { enabled: false, time: "07:30" },
  };
}

/** A partial update to the preferences (PUT /api/notifications/prefs). `verticals`, when given, replaces the overrides wholesale. */
export const PrefsPatch = z.object({
  categories: z.partialRecord(z.enum(NOTIFICATION_CATEGORIES), CategoryPrefsSchema.partial()).optional(),
  verticals: NotificationPrefsSchema.shape.verticals.optional(),
  quietHours: NotificationPrefsSchema.shape.quietHours.partial().optional(),
  rateLimit: NotificationPrefsSchema.shape.rateLimit.partial().optional(),
  quickBriefing: NotificationPrefsSchema.shape.quickBriefing.partial().optional(),
});
export type PrefsPatch = z.infer<typeof PrefsPatch>;

/** Applies a patch (or stored, possibly older, prefs) on top of `base`. Unknown keys are dropped. */
export function mergePrefs(base: NotificationPrefs, patch: unknown): NotificationPrefs {
  const p = PrefsPatch.safeParse(patch ?? {});
  if (!p.success) return base;
  const v = p.data;
  const categories = { ...base.categories };
  for (const cat of NOTIFICATION_CATEGORIES) {
    const over = v.categories?.[cat];
    if (over) categories[cat] = { ...categories[cat], ...over };
  }
  return {
    categories,
    verticals: v.verticals ?? base.verticals,
    quietHours: { ...base.quietHours, ...v.quietHours },
    rateLimit: { ...base.rateLimit, ...v.rateLimit },
    quickBriefing: { ...base.quickBriefing, ...v.quickBriefing },
  };
}

/** A category's effective settings, with any per-vertical override applied. */
export function resolveCategory(prefs: NotificationPrefs, category: NotificationCategory, vertical?: string | null): CategoryPrefs {
  const base = prefs.categories[category];
  const over = vertical ? prefs.verticals[vertical]?.[category] : undefined;
  return over ? { ...base, ...over } : base;
}

/**
 * The category for a notification that did not say. Older call sites (and
 * ones added concurrently) pass only `{title, body, url}`; these rules map
 * the common ones, and everything else is `agent`.
 */
export function inferCategory(n: Pick<NotificationInput, "title" | "url" | "category">): NotificationCategory {
  if (isCategory(n.category)) return n.category;
  const title = n.title.toLowerCase();
  const url = n.url ?? "";
  if (url.startsWith("/approvals") || /^approve\b/.test(title)) return "approval";
  if (/\bbrief(ing)?\b|\bwrap[- ]?up\b|evening wrap/.test(title)) return "briefing";
  if (/\bremind(er)?\b/.test(title)) return "reminder";
  if (/\bdigest\b/.test(title)) return "digest";
  if (/\bbudget\b|\bfail(ed|ure)?\b|\berror\b|\bdown\b|\balert\b|sign[- ]?in|\blogin\b/.test(title)) return "alert";
  if (/\border(s)?\b/.test(title) || url.startsWith("/orders")) return "orders";
  if (url.startsWith("/social")) return "social";
  return "agent";
}

export const priorityRank = (p: NotificationPriority): number => 3 - NOTIFICATION_PRIORITIES.indexOf(p);

/** Whether a device whose lowest accepted priority is `min` should get a push of `priority`. */
export const deviceAccepts = (min: NotificationPriority, priority: NotificationPriority): boolean =>
  priorityRank(priority) >= priorityRank(min);

// --- Quiet hours ---

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** Local wall-clock parts of an instant in `timezone`. */
function localParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}

/** Minutes since local midnight. */
export function localMinutes(at: Date, timezone: string): number {
  const p = localParts(at, timezone);
  return p.hour * 60 + p.minute;
}

function offsetMs(at: Date, timezone: string): number {
  const p = localParts(at, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant the local clock in `timezone` shows `hhmm` on local `day` (YYYY-MM-DD). */
export function localInstant(day: string, hhmm: string, timezone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const mins = minutesOf(hhmm);
  const guess = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  // Two passes settle the offset across a DST change.
  let at = guess - offsetMs(new Date(guess), timezone);
  at = guess - offsetMs(new Date(at), timezone);
  return new Date(at);
}

export function localDayOf(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Whether `at` falls in quiet hours. A window like 22:00–07:00 crosses midnight. Equal start and end means none. */
export function inQuietHours(at: Date, q: NotificationPrefs["quietHours"]): boolean {
  if (!q.enabled) return false;
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  if (s === e) return false;
  const m = localMinutes(at, q.timezone);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** When the quiet hours that `at` is in end (the next local `end` after `at`). */
export function quietHoursEnd(at: Date, q: NotificationPrefs["quietHours"]): Date {
  const today = localDayOf(at, q.timezone);
  const candidate = localInstant(today, q.end, q.timezone);
  if (candidate > at) return candidate;
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return localInstant(tomorrow, q.end, q.timezone);
}

/** Whether a notification may push during quiet hours: urgent always, approvals if allowed. */
export function breaksQuietHours(category: NotificationCategory, priority: NotificationPriority, q: NotificationPrefs["quietHours"]): boolean {
  return priority === "urgent" || (category === "approval" && q.allowApprovals);
}

// --- What happens to one notification ---

export type Route =
  | { kind: "muted" }
  | { kind: "inapp" }
  | { kind: "batched" }
  | { kind: "held" }
  | { kind: "push" }
  | { kind: "collapse" };

/**
 * Decides a notification's route from its resolved category settings, the
 * time, and how many pushes this category already had in the rate window.
 */
export function decideRoute(input: {
  category: NotificationCategory;
  priority: NotificationPriority;
  settings: CategoryPrefs;
  prefs: NotificationPrefs;
  now: Date;
  /** Pushes of this category inside the rate window, before this one. */
  recentPushes: number;
}): Route {
  const { category, priority, settings, prefs } = input;
  if (!settings.enabled) return { kind: "muted" };
  if (settings.delivery === "silent") return { kind: "inapp" };
  // The digest is where batched notifications go, so it never batches itself.
  if (settings.delivery === "digest" && category !== "digest") return { kind: "batched" };
  if (inQuietHours(input.now, prefs.quietHours) && !breaksQuietHours(category, priority, prefs.quietHours)) return { kind: "held" };
  const limit = prefs.rateLimit.perCategory;
  // Each business sends its digest at the same moment once a day, so digests are never rate limited.
  if (limit > 0 && priority !== "urgent" && category !== "digest" && input.recentPushes >= limit) return { kind: "collapse" };
  return { kind: "push" };
}

// --- Push payloads ---

/** What the service worker receives (apps/web/public/sw.js). */
export interface PushPayload {
  id?: string;
  title: string;
  body: string;
  url: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  tag?: string;
  renotify: boolean;
  silent: boolean;
  requireInteraction: boolean;
  actions: { action: string; title: string }[];
  data: Record<string, unknown>;
  /** Unread count in the notification centre, for the app badge. */
  unread?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function pushPayload(n: Omit<StoredNotification, "status" | "createdAt" | "pushedAt" | "readAt"> & { renotify?: boolean }, sound: boolean, unread?: number): PushPayload {
  const high = n.priority === "urgent" || n.priority === "high";
  let body = n.body;
  // One approvals notification stands for all of them: say how many more are waiting.
  const pending = n.data.pendingApprovals;
  if (n.category === "approval" && typeof pending === "number" && pending > 1) body += `\n+${pending - 1} more waiting`;
  return {
    id: n.id,
    title: clip(n.title, 120),
    body: clip(body, 1000),
    url: n.url ?? "/notifications",
    category: n.category,
    priority: n.priority,
    tag: n.tag ?? undefined,
    renotify: Boolean(n.tag) && (n.renotify ?? high),
    silent: !sound,
    requireInteraction: n.priority === "urgent",
    actions: n.actions.slice(0, 2),
    data: { ...n.data, notificationId: n.id },
    unread,
  };
}

/** The "and N more" push that stands in for a category's pushes over the rate limit. One per category, replaced in place. */
export function collapsedPayload(category: NotificationCategory, extra: number, latestTitle: string, sound: boolean, unread?: number): PushPayload {
  const label = CATEGORY_LABELS[category];
  return {
    title: `${label}: and ${extra} more`,
    body: `Latest: ${clip(latestTitle, 200)}`,
    url: `/notifications?category=${category}`,
    category,
    priority: "normal",
    tag: `more-${category}`,
    // Replacing the same tag quietly: one alert for the first extra, then silent updates.
    renotify: false,
    silent: !sound || extra > 1,
    requireInteraction: false,
    actions: [],
    data: { collapsed: extra },
    unread,
  };
}

/** The one push at the end of quiet hours for everything held. */
export function heldSummary(held: Pick<StoredNotification, "title" | "category">[], unread?: number): PushPayload {
  const counts = new Map<NotificationCategory, number>();
  for (const h of held) counts.set(h.category, (counts.get(h.category) ?? 0) + 1);
  const byCategory = [...counts].map(([c, k]) => `${k} ${CATEGORY_LABELS[c].toLowerCase()}`).join(", ");
  const lines = held.slice(0, 4).map((h) => `• ${clip(h.title, 80)}`);
  if (held.length > 4) lines.push(`+${held.length - 4} more`);
  return {
    title: `${held.length} notification${held.length === 1 ? "" : "s"} during quiet hours`,
    body: [byCategory, ...lines].join("\n"),
    url: "/notifications",
    category: "system",
    priority: "normal",
    tag: "quiet-summary",
    renotify: true,
    silent: false,
    requireInteraction: false,
    actions: [],
    data: { released: held.length },
    unread,
  };
}

/** The line a digest push gains for the notifications batched into it. */
export function batchedLine(batched: Pick<StoredNotification, "category">[]): string {
  const counts = new Map<NotificationCategory, number>();
  for (const b of batched) counts.set(b.category, (counts.get(b.category) ?? 0) + 1);
  const ordered = [...counts].sort(([a], [b]) => NOTIFICATION_CATEGORIES.indexOf(a) - NOTIFICATION_CATEGORIES.indexOf(b));
  return `Also: ${ordered.map(([c, k]) => `${k} ${CATEGORY_LABELS[c].toLowerCase()}`).join(", ")} (in Notifications)`;
}

export interface QuickBriefingStats {
  pendingApprovals: number;
  tasks: { total: number; done: number; failed: number; open: number };
  costUsd: number;
  budgetUsd: number | null;
  unread: number;
}

/** The deterministic quick briefing (no agent run). */
export function quickBriefingBody(s: QuickBriefingStats): string {
  const t = s.tasks;
  const taskParts = [`${t.done} done`];
  if (t.failed) taskParts.push(`${t.failed} failed`);
  if (t.open) taskParts.push(`${t.open} open`);
  const budget = s.budgetUsd ? ` of $${s.budgetUsd.toFixed(2)}` : "";
  return [
    `${s.pendingApprovals} approval${s.pendingApprovals === 1 ? "" : "s"} waiting`,
    `Tasks today: ${t.total} (${taskParts.join(", ")})`,
    `Spent today: $${s.costUsd.toFixed(2)}${budget}`,
    `${s.unread} unread notification${s.unread === 1 ? "" : "s"}`,
  ].join("\n");
}

/** Whether the quick briefing is due: within the hour after its time (so a restart just after still sends it). */
export function quickBriefingDue(now: Date, prefs: NotificationPrefs): boolean {
  if (!prefs.quickBriefing.enabled) return false;
  const m = localMinutes(now, prefs.quietHours.timezone);
  const t = minutesOf(prefs.quickBriefing.time);
  return (m - t + 1440) % 1440 < 60;
}
