import { useEffect, useMemo, useState } from "react";
import { type Connection, createApi, loadConnection, saveConnection } from "./api";
import { usd } from "./format";
import { LiveFeed, useLive, useLoad } from "./live";
import { NotificationSettings } from "./pages/NotificationSettings";
import { Briefing, Notifications } from "./pages/Notifications";
import { Approvals } from "./pages/Approvals";
import { Brain } from "./pages/Brain";
import { Chat } from "./pages/Chat";
import { Devices } from "./pages/Devices";
import { Inbox } from "./pages/Inbox";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";
import { Social } from "./pages/Social";
import { TaskView } from "./pages/TaskView";
import { go, routeQuery, useRoute } from "./router";

export function App() {
  const [conn, setConn] = useState<Connection | null>(loadConnection);
  if (!conn) {
    return (
      <Login
        onConnect={(c) => {
          saveConnection(c);
          setConn(c);
        }}
      />
    );
  }
  return (
    <Shell
      conn={conn}
      onSignOut={() => {
        saveConnection(null);
        setConn(null);
      }}
    />
  );
}

const NAV = [
  ["inbox", "Inbox"],
  ["approvals", "Approvals"],
  ["chat", "Chat"],
  ["social", "Social"],
  ["brain", "Brain"],
  ["devices", "Devices"],
  ["settings", "Settings"],
] as const;

function Shell({ conn, onSignOut }: { conn: Connection; onSignOut: () => void }) {
  const api = useMemo(() => createApi(conn), [conn]);
  const feed = useMemo(() => new LiveFeed(api), [api]);
  const [online, setOnline] = useState(false);
  const [page, id] = useRoute();

  useEffect(() => {
    feed.onStatus = setOnline;
    return () => feed.close();
  }, [feed]);

  const stats = useLoad(api.stats, feed, (m) => m.type === "proposal.updated" || m.type === "task.updated");
  const pending = stats.data?.pendingApprovals ?? 0;
  const unread = useUnread(api, feed, page);

  let body;
  switch (page) {
    case "task":
      body = <TaskView api={api} feed={feed} id={id!} />;
      break;
    case "approvals":
      body = <Approvals api={api} feed={feed} id={id} />;
      break;
    // --- notifications ---
    case "notifications":
      body = <Notifications api={api} feed={feed} />;
      break;
    case "notification-settings":
      body = <NotificationSettings api={api} />;
      break;
    case "briefing":
      body = <Briefing api={api} feed={feed} id={id} />;
      break;
    // --- end notifications ---
    case "chat":
      body = <Chat api={api} feed={feed} />;
      break;
    case "social":
      body = <Social api={api} feed={feed} />;
      break;
    case "brain":
      body = <Brain api={api} path={id ? decodeURIComponent(id) : undefined} />;
      break;
    case "devices":
      body = <Devices api={api} feed={feed} />;
      break;
    case "settings":
      body = <Settings api={api} onSignOut={onSignOut} />;
      break;
    default:
      body = <Inbox api={api} feed={feed} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => go("inbox")}>
          Command Centre
        </button>
        <span className={`dot ${online ? "on" : ""}`} title={online ? "Live" : "Reconnecting"} />
        <span className="muted small">{stats.data ? `today ${usd(stats.data.costTodayUsd)}` : ""}</span>
        <a href="#/notifications" className={`bell ${page === "notifications" ? "active" : ""}`} aria-label={`Notifications, ${unread} unread`} title="Notifications">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
        </a>
      </header>
      <nav className="nav">
        {NAV.map(([key, label]) => (
          <a key={key} href={`#/${key}`} className={page === key || (key === "inbox" && page === "task") ? "active" : ""}>
            {label}
            {key === "approvals" && pending > 0 && <span className="badge">{pending}</span>}
          </a>
        ))}
      </nav>
      <main className="main">{body}</main>
    </div>
  );
}

// --- notifications ---
/**
 * The notification centre's unread count, live, mirrored to the app icon
 * badge (Badging API) where supported. A route opened from a push carries
 * `n=<id>`, which marks that notification read.
 */
function useUnread(api: ReturnType<typeof createApi>, feed: LiveFeed, page: string | undefined): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    api.unreadCount().then((r) => setUnread(r.unread), () => {});
  }, [api]);
  useLive(feed, (m) => {
    if (m.type === "notifications.updated") setUnread(m.unread);
  });
  useEffect(() => {
    const n = routeQuery().get("n");
    if (n) api.markRead(n).then((r) => setUnread(r.unread), () => {});
  }, [api, page, location.hash]);
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    (unread > 0 ? nav.setAppBadge(unread) : nav.clearAppBadge!()).catch(() => {});
  }, [unread]);
  return unread;
}
// --- end notifications ---
