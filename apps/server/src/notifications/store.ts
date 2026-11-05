import { randomUUID } from "node:crypto";
import type {
  NotificationAction,
  NotificationCategory,
  NotificationDevice,
  NotificationMedia,
  NotificationPriority,
  NotificationStatus,
  StoredNotification,
} from "@cc/core";
import type { Pool } from "../db/pool";

type Row = Record<string, any>;
const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

const toNotification = (r: Row): StoredNotification => ({
  id: r.id,
  category: r.category,
  priority: r.priority,
  vertical: r.vertical,
  title: r.title,
  body: r.body,
  url: r.url,
  tag: r.tag,
  actions: r.actions ?? [],
  media: r.media ?? [],
  data: r.data ?? {},
  status: r.status,
  createdAt: iso(r.created_at)!,
  pushedAt: iso(r.pushed_at),
  readAt: iso(r.read_at),
});

const toDevice = (r: Row): NotificationDevice => ({
  id: r.id,
  name: r.name,
  platform: r.platform,
  userAgent: r.user_agent,
  minPriority: r.min_priority,
  createdAt: iso(r.created_at)!,
  lastSuccessAt: iso(r.last_success_at),
  lastFailureAt: iso(r.last_failure_at),
  lastError: r.last_error,
});

export interface NewNotification {
  id?: string;
  userId: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  vertical: string | null;
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
  actions: NotificationAction[];
  media: NotificationMedia[];
  data: Record<string, unknown>;
  status: NotificationStatus;
  pushed: boolean;
  read: boolean;
  createdAt: Date;
}

/** SQL for the notification centre, preferences and devices (migration 0010_notifications). */
export class NotificationStore {
  constructor(readonly pool: Pool) {}

  // --- Inbox ---

  async insert(n: NewNotification): Promise<StoredNotification> {
    const { rows } = await this.pool.query(
      `insert into notifications (id, user_id, category, priority, vertical, title, body, url, tag, actions, data, status, created_at, pushed_at, read_at, media)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, case when $14 then $13::timestamptz end, case when $15 then $13::timestamptz end, $16)
       returning *`,
      [
        n.id ?? randomUUID(),
        n.userId,
        n.category,
        n.priority,
        n.vertical,
        n.title,
        n.body,
        n.url,
        n.tag,
        JSON.stringify(n.actions),
        JSON.stringify(n.data),
        n.status,
        n.createdAt,
        n.pushed,
        n.read,
        JSON.stringify(n.media),
      ],
    );
    return toNotification(rows[0]);
  }

  async setUrl(id: string, url: string): Promise<void> {
    await this.pool.query("update notifications set url = $2 where id = $1", [id, url]);
  }

  async get(userId: string, id: string): Promise<StoredNotification | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query("select * from notifications where user_id = $1 and id = $2", [userId, id]);
    return rows[0] ? toNotification(rows[0]) : null;
  }

  async list(
    userId: string,
    options: { category?: NotificationCategory; unread?: boolean; limit?: number; before?: Date } = {},
  ): Promise<StoredNotification[]> {
    const { rows } = await this.pool.query(
      `select * from notifications
       where user_id = $1 and ($2::text is null or category = $2) and (not $3 or read_at is null) and ($4::timestamptz is null or created_at < $4)
       order by created_at desc, id limit $5`,
      [userId, options.category ?? null, options.unread ?? false, options.before ?? null, options.limit ?? 50],
    );
    return rows.map(toNotification);
  }

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await this.pool.query("select count(*)::int as n from notifications where user_id = $1 and read_at is null", [userId]);
    return rows[0].n;
  }

  async unreadByCategory(userId: string): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(
      "select category, count(*)::int as n from notifications where user_id = $1 and read_at is null group by category",
      [userId],
    );
    return Object.fromEntries(rows.map((r) => [r.category, r.n]));
  }

  async markRead(userId: string, id: string): Promise<StoredNotification | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      "update notifications set read_at = coalesce(read_at, now()) where user_id = $1 and id = $2 returning *",
      [userId, id],
    );
    return rows[0] ? toNotification(rows[0]) : null;
  }

  async markAllRead(userId: string, category?: NotificationCategory): Promise<number> {
    const { rowCount } = await this.pool.query(
      "update notifications set read_at = now() where user_id = $1 and read_at is null and ($2::text is null or category = $2)",
      [userId, category ?? null],
    );
    return rowCount ?? 0;
  }

  /** Marks read every notification whose `data[key]` is `value`, e.g. the approval request for a decided proposal. */
  async markReadByData(userId: string, key: string, value: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      "update notifications set read_at = now() where user_id = $1 and read_at is null and data ->> $2 = $3",
      [userId, key, value],
    );
    return rowCount ?? 0;
  }

  /** Pushes (and collapsed extras) of a category since `since`, for the rate limit. */
  async windowCounts(userId: string, category: NotificationCategory, since: Date): Promise<{ sent: number; collapsed: number }> {
    const { rows } = await this.pool.query(
      `select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'collapsed')::int as collapsed
       from notifications where user_id = $1 and category = $2 and created_at >= $3`,
      [userId, category, since],
    );
    return { sent: rows[0].sent, collapsed: rows[0].collapsed };
  }

  /** Atomically moves every notification in `from` to `to`, returning them oldest first. */
  async take(userId: string, from: NotificationStatus, to: NotificationStatus): Promise<StoredNotification[]> {
    const { rows } = await this.pool.query(
      `update notifications set status = $3, pushed_at = case when $3 = 'released' then now() else pushed_at end
       where user_id = $1 and status = $2 returning *`,
      [userId, from, to],
    );
    return rows.map(toNotification).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async countStatus(userId: string, status: NotificationStatus): Promise<number> {
    const { rows } = await this.pool.query("select count(*)::int as n from notifications where user_id = $1 and status = $2", [userId, status]);
    return rows[0].n;
  }

  // --- Preferences ---

  async getPrefs(userId: string): Promise<unknown> {
    const { rows } = await this.pool.query("select prefs from notification_prefs where user_id = $1", [userId]);
    return rows[0]?.prefs ?? null;
  }

  async savePrefs(userId: string, prefs: unknown): Promise<void> {
    await this.pool.query(
      `insert into notification_prefs (user_id, prefs) values ($1, $2)
       on conflict (user_id) do update set prefs = excluded.prefs, updated_at = now()`,
      [userId, JSON.stringify(prefs)],
    );
  }

  /** True the first time `job` runs for `day`; false if it already has (shared across replicas and restarts). */
  async claimRun(userId: string, job: string, day: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "insert into notification_runs (user_id, job, day) values ($1, $2, $3) on conflict do nothing",
      [userId, job, day],
    );
    return rowCount === 1;
  }

  // --- Devices (push_subscriptions with metadata) ---

  async saveDevice(
    userId: string,
    d: { subscription: { endpoint: string }; name: string | null; platform: string | null; userAgent: string | null },
  ): Promise<NotificationDevice> {
    const { rows } = await this.pool.query(
      `insert into push_subscriptions (endpoint, subscription, user_id, name, platform, user_agent) values ($1, $2, $3, $4, $5, $6)
       on conflict (endpoint) do update set subscription = excluded.subscription, user_id = excluded.user_id,
         name = coalesce(excluded.name, push_subscriptions.name), platform = coalesce(excluded.platform, push_subscriptions.platform),
         user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent)
       returning *`,
      [d.subscription.endpoint, JSON.stringify(d.subscription), userId, d.name, d.platform, d.userAgent],
    );
    return toDevice(rows[0]);
  }

  async listDevices(userId: string): Promise<NotificationDevice[]> {
    const { rows } = await this.pool.query("select * from push_subscriptions where user_id = $1 order by created_at", [userId]);
    return rows.map(toDevice);
  }

  /** Devices with their raw subscriptions, for sending. */
  async listDeviceSubscriptions(userId: string): Promise<(NotificationDevice & { subscription: any; endpoint: string })[]> {
    const { rows } = await this.pool.query("select * from push_subscriptions where user_id = $1 order by created_at", [userId]);
    return rows.map((r) => ({ ...toDevice(r), subscription: r.subscription, endpoint: r.endpoint }));
  }

  async updateDevice(userId: string, id: string, patch: { name?: string; minPriority?: NotificationPriority }): Promise<NotificationDevice | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query(
      `update push_subscriptions set name = coalesce($3, name), min_priority = coalesce($4, min_priority)
       where user_id = $1 and id = $2 returning *`,
      [userId, id, patch.name ?? null, patch.minPriority ?? null],
    );
    return rows[0] ? toDevice(rows[0]) : null;
  }

  async deleteDevice(userId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const { rowCount } = await this.pool.query("delete from push_subscriptions where user_id = $1 and id = $2", [userId, id]);
    return rowCount === 1;
  }

  async deleteDeviceByEndpoint(endpoint: string): Promise<void> {
    await this.pool.query("delete from push_subscriptions where endpoint = $1", [endpoint]);
  }

  async recordDelivery(endpoint: string, error: string | null): Promise<void> {
    if (error === null) {
      await this.pool.query("update push_subscriptions set last_success_at = now(), last_error = null where endpoint = $1", [endpoint]);
    } else {
      await this.pool.query("update push_subscriptions set last_failure_at = now(), last_error = $2 where endpoint = $1", [endpoint, error.slice(0, 500)]);
    }
  }

  // --- Quick briefing counts ---

  async quickCounts(since: Date): Promise<{ pendingApprovals: number; tasks: { total: number; done: number; failed: number; open: number } }> {
    const [p, t] = await Promise.all([
      this.pool.query("select count(*)::int as n from proposals where status = 'pending'"),
      this.pool.query("select status, count(*)::int as n from tasks where created_at >= $1 group by status", [since]),
    ]);
    const by: Record<string, number> = Object.fromEntries(t.rows.map((r) => [r.status, r.n as number]));
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const done = by.done ?? 0;
    const failed = by.failed ?? 0;
    const closed = done + failed + (by.dropped ?? 0);
    return { pendingApprovals: p.rows[0].n, tasks: { total, done, failed, open: total - closed } };
  }
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
