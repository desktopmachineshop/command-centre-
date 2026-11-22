import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES, type NotificationMedia, type StoredNotification } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago, dayLabel } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { go, routeQuery } from "../router";
import { MediaThumbs } from "../social";
import { VTag } from "../ui";
import { VideoPreview } from "../video";

/** What happened to a notification that wasn't simply pushed, in plain words. */
const STATUS_LABEL: Partial<Record<StoredNotification["status"], string>> = {
  held: "Not pushed yet: it arrived in quiet hours, and goes out when they end",
  released: "Arrived in quiet hours; pushed when they ended",
  collapsed: "Not pushed on its own: several came at once, so your devices got one summary",
  batched: "Not pushed: waiting to be listed with the next daily digest",
  digested: "Not pushed on its own: listed with the daily digest",
  inapp: "Kept in the app only (not pushed)",
  muted: "Muted",
};
export const statusNote = (n: Pick<StoredNotification, "status">): string | null => STATUS_LABEL[n.status] ?? null;

/**
 * Where a notification leads: its own link, and the task it came from when that is somewhere
 * else (an agent's message links back to the conversation that produced it).
 */
export function notificationLinks(n: Pick<StoredNotification, "url" | "data" | "category">): { label: string; route: string }[] {
  const links: { label: string; route: string }[] = [];
  const route = n.url?.replace(/^\//, "");
  if (route) {
    const label = route.startsWith("approvals") ? "Review it" : route.startsWith("task/") ? "Open the conversation" : route.startsWith("brain/") ? "Read the note" : route.startsWith("briefing/") ? "Open the briefing" : "Open";
    links.push({ label, route });
  }
  const taskId = typeof n.data?.taskId === "string" ? n.data.taskId : null;
  if (taskId && route !== `task/${taskId}`) links.push({ label: "Open the conversation", route: `task/${taskId}` });
  return links;
}

/** More lines than this and the text is folded, with a button to show the rest. */
const LONG_BODY = 600;

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

/**
 * The notification centre: everything Command Centre has told Dave, newest first under the day
 * it arrived, each in full (its text, pictures, what happened to it, and where it leads) so
 * nothing needs opening to be read. Reading one here marks it read.
 */
export function Notifications({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [category, setCategory] = useState<string>(() => routeQuery().get("category") ?? "");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, error, reload } = useLoad(
    () => api.notifications({ category: category || undefined, unread: unreadOnly, limit: 100 }),
    feed,
    (m) => m.type === "notifications.updated",
    [category, unreadOnly],
  );
  const groups: { day: string; items: StoredNotification[] }[] = [];
  for (const n of data?.items ?? []) {
    const day = dayLabel(n.createdAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(n);
    else groups.push({ day, items: [n] });
  }

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
      {data?.items.length === 0 && <p className="muted">{unreadOnly ? "Nothing unread." : "No notifications."}</p>}
      {groups.map((g) => (
        <div key={g.day} className="notification-day">
          <h3 className="small muted">{g.day}</h3>
          <ul className="list">
            {g.items.map((n) => (
              <NotificationItem key={n.id} api={api} n={n} onChange={reload} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function NotificationItem({ api, n, onChange }: { api: Api; n: StoredNotification; onChange: () => void }) {
  const long = n.body.length > LONG_BODY || n.body.split("\n").length > 12;
  const [open, setOpen] = useState(false);
  const links = notificationLinks(n);
  const note = statusNote(n);
  const follow = async (route: string) => {
    if (!n.readAt) await api.markRead(n.id).catch(() => {});
    go(route);
  };
  return (
    <li className={`item notification ${n.readAt ? "read" : "unread"}`}>
      <div className="row between small">
        <span>
          <span className="tag">{CATEGORY_LABELS[n.category]}</span> {n.vertical && <VTag id={n.vertical} />}
          {!n.readAt && <span className="badge">new</span>}
        </span>
        <span className="muted" title={new Date(n.createdAt).toLocaleString()}>
          {new Date(n.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <p className="title">{n.title}</p>
      {n.body && <p className={`prewrap notification-body ${long && !open ? "is-folded" : ""}`}>{n.body}</p>}
      {long && (
        <button type="button" className="link small" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show all of it"}
        </button>
      )}
      <NotificationMediaView media={n.media} title={n.title} />
      {note && <p className="muted small notification-status">{note}</p>}
      <div className="row wrap small notification-links">
        {links.map((l) => (
          <button key={l.route} type="button" className="link" onClick={() => void follow(l.route)}>
            {l.label}
          </button>
        ))}
        {!n.readAt && (
          <button type="button" className="link muted" onClick={() => void api.markRead(n.id).then(onChange, () => {})}>
            Mark read
          </button>
        )}
      </div>
    </li>
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
              .map((line, i) =>
                // The brief's last line is the day's lesson (skills/career-coach): it opens Learning.
                /^learning:/i.test(line.trim()) ? (
                  <li key={i}>
                    <a href="#/learning">{line}</a>
                  </li>
                ) : (
                  <li key={i}>{line}</li>
                ),
              )}
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
