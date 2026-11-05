import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES, type NotificationMedia, type StoredNotification } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { go, routeQuery } from "../router";
import { MediaThumbs } from "../social";
import { VideoPreview } from "../video";

const STATUS_LABEL: Partial<Record<StoredNotification["status"], string>> = {
  held: "held for quiet hours",
  released: "sent after quiet hours",
  collapsed: "collapsed",
  batched: "waiting for the digest",
  digested: "in the digest",
  inapp: "in app only",
  muted: "muted",
};

/** A notification's pictures and videos in full: videos play in place, images show at their own size. */
export function NotificationMediaView({ media, title }: { media?: NotificationMedia[]; title: string }) {
  if (!media?.length) return null;
  return (
    <div className="notification-media">
      {media.map((m, i) =>
        m.type === "video" ? (
          <VideoPreview key={`${m.url}-${i}`} video={m} title={m.alt ?? title} />
        ) : (
          <figure key={`${m.url}-${i}`} className="image-preview">
            <a href={m.url} target="_blank" rel="noreferrer">
              <img src={m.url} alt={m.alt ?? ""} loading="lazy" />
            </a>
          </figure>
        ),
      )}
    </div>
  );
}

/** Opens a notification's link (in-app routes only) after marking it read. */
export async function openNotification(api: Api, n: StoredNotification) {
  if (!n.readAt) await api.markRead(n.id).catch(() => {});
  go((n.url ?? `/briefing/${n.id}`).replace(/^\//, ""));
}

/** The notification centre: every notification, filterable by category. */
export function Notifications({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [category, setCategory] = useState<string>(() => routeQuery().get("category") ?? "");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, error, reload } = useLoad(
    () => api.notifications({ category: category || undefined, unread: unreadOnly, limit: 100 }),
    feed,
    (m) => m.type === "notifications.updated",
    [category, unreadOnly],
  );

  return (
    <section className="notifications">
      <div className="row between">
        <h2>Notifications</h2>
        <a href="#/notification-settings" className="small">
          Notification settings
        </a>
      </div>
      <div className="row wrap">
        <label className="small">
          Category{" "}
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {NOTIFICATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
                {data?.unreadByCategory[c] ? ` (${data.unreadByCategory[c]})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
        </label>
        <button disabled={!data?.unread} onClick={() => api.markAllRead(category || undefined).then(reload)}>
          Mark all read
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {data?.items.length === 0 && <p className="muted">No notifications.</p>}
      <ul className="list">
        {data?.items.map((n) => (
          <li key={n.id} className={`item notification ${n.readAt ? "read" : "unread"}`} onClick={() => openNotification(api, n)}>
            <div className="row between small">
              <span>
                <span className="tag">{CATEGORY_LABELS[n.category]}</span> {n.vertical && <span className="muted">{n.vertical}</span>}
                {!n.readAt && <span className="badge">new</span>}
              </span>
              <span className="muted">{ago(n.createdAt)}</span>
            </div>
            <p className="title">{n.title}</p>
            <p className="prewrap small clip">{n.body}</p>
            <MediaThumbs media={n.media} />
            {STATUS_LABEL[n.status] && <p className="muted small">{STATUS_LABEL[n.status]}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A briefing (morning brief, evening wrap, quick briefing) in full; without an id, the latest ones. */
export function Briefing({ api, feed, id }: { api: Api; feed: LiveFeed; id?: string }) {
  const one = useLoad(() => (id ? api.notification(id) : Promise.resolve(null)), feed, () => false, [id]);
  const list = useLoad(() => api.notifications({ category: "briefing", limit: 10 }), feed, (m) => m.type === "notifications.updated");
  const n = one.data;
  return (
    <section className="briefing">
      <h2>Briefing</h2>
      {one.error && <p className="error">{one.error}</p>}
      {n && (
        <article className="card">
          <p className="muted small">{new Date(n.createdAt).toLocaleString()}</p>
          <h3>{n.title}</h3>
          <ul className="briefing-lines">
            {n.body
              .split("\n")
              .filter(Boolean)
              .map((line, i) => (
                <li key={i}>{line}</li>
              ))}
          </ul>
          <NotificationMediaView media={n.media} title={n.title} />
        </article>
      )}
      <h3>Recent briefings</h3>
      {list.data?.items.length === 0 && <p className="muted">No briefings yet.</p>}
      <ul className="list">
        {list.data?.items
          .filter((b) => b.id !== id)
          .map((b) => (
            <li key={b.id} className="item" onClick={() => go(`briefing/${b.id}`)}>
              <div className="row between small">
                <span className="title">{b.title}</span>
                <span className="muted">{ago(b.createdAt)}</span>
              </div>
              <p className="small clip prewrap">{b.body}</p>
              <MediaThumbs media={b.media} />
            </li>
          ))}
      </ul>
    </section>
  );
}
