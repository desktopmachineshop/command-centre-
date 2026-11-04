import { randomUUID } from "node:crypto";
import {
  CATEGORY_LABELS,
  type NotificationAction,
  type NotificationCategory,
  type NotificationInput,
  type NotificationMedia,
  type NotificationPrefs,
  type NotificationPriority,
  type StoredNotification,
} from "@cc/core";
import { Cron } from "croner";
import type { Notifier, PushTransport, PushUrgency } from "../push";
import {
  batchedLine,
  collapsedPayload,
  DEFAULT_USER,
  decideRoute,
  defaultPrefs,
  deviceAccepts,
  heldSummary,
  inferCategory,
  inQuietHours,
  isCategory,
  isPriority,
  localDayOf,
  localInstant,
  mergePrefs,
  type PushPayload,
  pushPayload,
  quickBriefingBody,
  quickBriefingDue,
  quietHoursEnd,
  resolveCategory,
  type Route,
} from "./policy";
import type { NotificationStore } from "./store";

const URGENCY: Record<NotificationPriority, PushUrgency> = { urgent: "high", high: "high", normal: "normal", low: "low" };
const TTL: Record<NotificationPriority, number> = { urgent: 86_400, high: 86_400, normal: 43_200, low: 21_600 };

const STATUS: Record<Route["kind"], StoredNotification["status"]> = {
  muted: "muted",
  inapp: "inapp",
  batched: "batched",
  held: "held",
  push: "sent",
  collapse: "collapsed",
};

/** A push service "topic" replaces an undelivered push with the same one: base64url, at most 32 characters. */
const topicOf = (tag: string | undefined) => (tag && /^[A-Za-z0-9_-]{1,32}$/.test(tag) ? tag : undefined);

export interface NotificationServiceOptions {
  /** Default timezone for quiet hours and "today" (DAY_TIMEZONE). */
  timezone: string;
  now?: () => Date;
  /** Called with the new unread count whenever it changes (the app broadcasts it to clients). */
  onUnreadChange?: (unread: number, userId: string) => void;
  /** Today's spend for the quick briefing. */
  spend?: (since: Date) => Promise<{ costUsd: number; budgetUsd: number | null }>;
}

/**
 * The notifier behind every `notify()`: stores each notification in the
 * in-app centre, then applies the preferences (category on/off, delivery,
 * sound, per-vertical overrides), quiet hours, the per-category rate limit
 * and per-device routing before pushing. A once-a-minute tick releases
 * what quiet hours held and sends the optional quick briefing.
 */
export class NotificationService implements Notifier {
  private readonly now: () => Date;

  constructor(
    readonly store: NotificationStore,
    private readonly transport: PushTransport,
    private readonly options: NotificationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  get publicKey(): string | null {
    return this.transport.publicKey;
  }

  defaults(): NotificationPrefs {
    return defaultPrefs(this.options.timezone);
  }

  async prefs(userId = DEFAULT_USER): Promise<NotificationPrefs> {
    return mergePrefs(this.defaults(), await this.store.getPrefs(userId));
  }

  async updatePrefs(patch: unknown, userId = DEFAULT_USER): Promise<NotificationPrefs> {
    const next = mergePrefs(await this.prefs(userId), patch);
    await this.store.savePrefs(userId, next);
    return next;
  }

  async notify(n: NotificationInput): Promise<void> {
    await this.send(n);
  }

  /**
   * Stores and routes one notification. `test` sends a test push that skips
   * on/off, delivery mode, quiet hours and the rate limit; with `deviceId`
   * only that device gets it, regardless of its routing.
   */
  async send(input: NotificationInput, options: { userId?: string; test?: boolean; deviceId?: string } = {}): Promise<StoredNotification> {
    const userId = options.userId ?? DEFAULT_USER;
    const now = this.now();
    const prefs = await this.prefs(userId);
    const n = normalize(input);
    const settings = resolveCategory(prefs, n.category, n.vertical);
    const priority = n.priority ?? settings.priority;

    let route: Route;
    if (options.test) route = { kind: "push" };
    else {
      const since = new Date(now.getTime() - prefs.rateLimit.windowMinutes * 60_000);
      const recent = await this.store.windowCounts(userId, n.category, since);
      route = decideRoute({ category: n.category, priority, settings, prefs, now, recentPushes: recent.sent });
    }

    let body = n.body;
    const data = { ...n.data };
    if (n.category === "digest" && route.kind !== "muted") {
      const batched = await this.store.take(userId, "batched", "digested");
      if (batched.length) {
        body += `\n${batchedLine(batched)}`;
        data.batched = batched.length;
      }
    }
    if (route.kind === "held") data.heldUntil = quietHoursEnd(now, prefs.quietHours).toISOString();

    const id = randomUUID();
    // Briefings open the briefing view of themselves.
    const url = n.url ?? (n.category === "briefing" ? `/briefing/${id}` : null);
    const stored = await this.store.insert({
      id,
      userId,
      category: n.category,
      priority,
      vertical: n.vertical,
      title: n.title,
      body,
      url,
      tag: n.tag,
      actions: n.actions,
      media: n.media,
      data,
      status: STATUS[route.kind],
      pushed: route.kind === "push",
      read: route.kind === "muted",
      createdAt: now,
    });
    const unread = await this.store.unreadCount(userId);
    this.options.onUnreadChange?.(unread, userId);

    if (route.kind === "push") {
      await this.deliver(userId, pushPayload({ ...stored, renotify: n.renotify }, settings.sound, unread), priority, options);
    } else if (route.kind === "collapse") {
      const since = new Date(now.getTime() - prefs.rateLimit.windowMinutes * 60_000);
      const { collapsed } = await this.store.windowCounts(userId, n.category, since);
      await this.deliver(userId, collapsedPayload(n.category, collapsed, n.title, settings.sound, unread), priority, {});
    }
    return stored;
  }

  /** A test push for one category (default `system`) and/or one device. */
  async sendTest(options: { category?: NotificationCategory; deviceId?: string; userId?: string } = {}): Promise<StoredNotification> {
    const userId = options.userId ?? DEFAULT_USER;
    const category = options.category ?? "system";
    const prefs = await this.prefs(userId);
    const s = prefs.categories[category];
    const q = prefs.quietHours;
    const delivery = { push: "push now", digest: "batched into the digest", silent: "in the app only" }[s.delivery];
    const lines = [
      `${CATEGORY_LABELS[category]}: ${s.enabled ? delivery : "off"}, sound ${s.sound ? "on" : "off"}, ${s.priority} priority.`,
      q.enabled ? `Quiet hours ${q.start}–${q.end} (${q.timezone}).` : "Quiet hours off.",
    ];
    return this.send(
      { title: `Test: ${CATEGORY_LABELS[category]}`, body: lines.join("\n"), category, url: "/notification-settings", tag: `test-${category}`, renotify: true },
      { userId, test: true, deviceId: options.deviceId },
    );
  }

  async markRead(id: string, userId = DEFAULT_USER): Promise<StoredNotification | null> {
    const n = await this.store.markRead(userId, id);
    if (n) this.options.onUnreadChange?.(await this.store.unreadCount(userId), userId);
    return n;
  }

  async markAllRead(category?: NotificationCategory, userId = DEFAULT_USER): Promise<number> {
    const changed = await this.store.markAllRead(userId, category);
    if (changed) this.options.onUnreadChange?.(await this.store.unreadCount(userId), userId);
    return changed;
  }

  /** Marks read the approval request(s) for a proposal once it is decided. */
  async resolveProposal(proposalId: string, userId = DEFAULT_USER): Promise<void> {
    if (await this.store.markReadByData(userId, "proposalId", proposalId)) {
      this.options.onUnreadChange?.(await this.store.unreadCount(userId), userId);
    }
  }

  /** Once a minute: release what quiet hours held, and send the quick briefing when due. */
  async tick(userId = DEFAULT_USER): Promise<void> {
    const now = this.now();
    const prefs = await this.prefs(userId);
    await this.releaseHeld(prefs, now, userId);
    if (quickBriefingDue(now, prefs) && (await this.store.claimRun(userId, "quick-briefing", localDayOf(now, prefs.quietHours.timezone)))) {
      await this.sendQuickBriefing(userId);
    }
  }

  /** Outside quiet hours, pushes one summary of everything they held. */
  async releaseHeld(prefs: NotificationPrefs, now: Date, userId = DEFAULT_USER): Promise<StoredNotification[]> {
    if (inQuietHours(now, prefs.quietHours)) return [];
    if ((await this.store.countStatus(userId, "held")) === 0) return [];
    const held = await this.store.take(userId, "held", "released");
    if (!held.length) return [];
    const top = held.some((h) => h.priority === "urgent" || h.priority === "high") ? "high" : "normal";
    await this.deliver(userId, heldSummary(held, await this.store.unreadCount(userId)), top, {});
    return held;
  }

  /** The deterministic counts briefing: approvals waiting, today's tasks, spend. No agent run. */
  async sendQuickBriefing(userId = DEFAULT_USER): Promise<StoredNotification> {
    const now = this.now();
    const since = localInstant(localDayOf(now, this.options.timezone), "00:00", this.options.timezone);
    const [counts, spend, unread] = await Promise.all([
      this.store.quickCounts(since),
      this.options.spend?.(since) ?? Promise.resolve({ costUsd: 0, budgetUsd: null }),
      this.store.unreadCount(userId),
    ]);
    return this.send(
      { title: "Quick briefing", body: quickBriefingBody({ ...counts, ...spend, unread }), category: "briefing", tag: "quick-briefing" },
      { userId },
    );
  }

  private async deliver(userId: string, payload: PushPayload, priority: NotificationPriority, options: { deviceId?: string }): Promise<number> {
    if (!this.transport.publicKey) return 0;
    const devices = (await this.store.listDeviceSubscriptions(userId)).filter((d) =>
      options.deviceId ? d.id === options.deviceId : deviceAccepts(d.minPriority, priority),
    );
    const body = JSON.stringify(payload);
    let sent = 0;
    for (const d of devices) {
      try {
        await this.transport.send(d.subscription, body, { urgency: URGENCY[priority], TTL: TTL[priority], topic: topicOf(payload.tag) });
        await this.store.recordDelivery(d.endpoint, null);
        sent++;
      } catch (err: any) {
        // Expired or revoked subscriptions are removed; anything else is retried next time.
        if (err?.statusCode === 404 || err?.statusCode === 410) await this.store.deleteDeviceByEndpoint(d.endpoint);
        else await this.store.recordDelivery(d.endpoint, String(err?.body ?? err?.message ?? err));
      }
    }
    return sent;
  }
}

/** Checks and fills in a caller's notification: unknown categories are inferred, bad fields dropped. */
export function normalize(input: NotificationInput) {
  const title = String(input.title ?? "").slice(0, 200) || "Command Centre";
  const body = String(input.body ?? "").slice(0, 4000);
  const url = typeof input.url === "string" && input.url.startsWith("/") ? input.url : null;
  const actions: NotificationAction[] = Array.isArray(input.actions)
    ? input.actions.filter((a) => a && typeof a.action === "string" && typeof a.title === "string").slice(0, 2)
    : [];
  return {
    title,
    body,
    url: url ?? undefined,
    category: inferCategory({ title, url: url ?? undefined, category: input.category }),
    priority: isPriority(input.priority) ? input.priority : undefined,
    vertical: typeof input.vertical === "string" && input.vertical ? input.vertical : null,
    tag: typeof input.tag === "string" && input.tag ? input.tag.slice(0, 64) : null,
    renotify: typeof input.renotify === "boolean" ? input.renotify : undefined,
    actions,
    media: normalizeMedia(input.media),
    data: input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : {},
  };
}

/** Keeps well-formed media only: absolute http(s) URLs, image or video, at most 4. */
export function normalizeMedia(media: unknown): NotificationMedia[] {
  if (!Array.isArray(media)) return [];
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
  const out: NotificationMedia[] = [];
  for (const m of media) {
    if (!m || typeof m !== "object") continue;
    const { url, type, alt, durationSec, width, height } = m as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url) || url.length > 2000) continue;
    if (type !== "image" && type !== "video") continue;
    const item: NotificationMedia = { url, type };
    if (typeof alt === "string" && alt) item.alt = alt.slice(0, 300);
    if (num(durationSec)) item.durationSec = num(durationSec);
    if (num(width)) item.width = num(width);
    if (num(height)) item.height = num(height);
    out.push(item);
    if (out.length === 4) break;
  }
  return out;
}

export { isCategory };

/** Sends every notification to `primary` and then `also` (tests observe call sites this way). */
export function teeNotifier(primary: Notifier, also: Notifier): Notifier {
  return {
    get publicKey() {
      return primary.publicKey;
    },
    async notify(n) {
      await primary.notify(n);
      await also.notify(n);
    },
  };
}

/** The every-minute notification job (quiet-hours release, quick briefing). Not an agent run. */
export function startNotificationJobs(service: NotificationService, timezone: string): Cron[] {
  return [
    new Cron("* * * * *", { timezone, protect: true }, async () => {
      await service.tick().catch((err) => console.error("[notifications]", err));
    }),
  ];
}
