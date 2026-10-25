import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useInstall } from "./install";
import { ApiError, COOKIE_SESSION, type Connection, createApi, loadConnection, saveConnection } from "./api";
import { usd } from "./format";
import { LiveFeed, useLive, useLoad } from "./live";
import { NotificationSettings } from "./pages/NotificationSettings";
import { Briefing, Notifications } from "./pages/Notifications";
import { Approvals } from "./pages/Approvals";
import { Brain } from "./pages/Brain";
import { Chat } from "./pages/Chat";
import { Connections } from "./pages/Connections";
import { Devices } from "./pages/Devices";
import { Drive } from "./pages/Drive";
import { Inbox } from "./pages/Inbox";
import { Login } from "./pages/Login";
import { Org } from "./pages/Org";
import { Settings } from "./pages/Settings";
import { Social } from "./pages/Social";
import { TaskView } from "./pages/TaskView";
import { Today } from "./pages/Today";
import { BrandMark, Icon, type IconName } from "./icons";
import { routeQuery, useRoute } from "./router";
import { useMedia, useTheme } from "./theme";
import { ThemeCycle, ThemeToggle, type VerticalInfo, VerticalsContext } from "./ui";

// --- auth: cookie session (or a stored admin token), first-run setup, sign-in ---
type AuthState =
  | { kind: "checking" }
  | { kind: "signedOut"; setupRequired: boolean; error?: string }
  | { kind: "signedIn"; conn: Connection };

/** Asks the server whether this browser has a session, and if not whether first-run setup is needed. */
async function checkSession(): Promise<AuthState> {
  const api = createApi(COOKIE_SESSION);
  try {
    await api.me();
    return { kind: "signedIn", conn: COOKIE_SESSION };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) return { kind: "signedOut", setupRequired: false, error: "Can't reach the server. Check your connection." };
  }
  try {
    return { kind: "signedOut", setupRequired: (await api.authStatus()).setupRequired };
  } catch {
    return { kind: "signedOut", setupRequired: false };
  }
}

export function App() {
  const [auth, setAuth] = useState<AuthState>(() => {
    const stored = loadConnection();
    return stored ? { kind: "signedIn", conn: stored } : { kind: "checking" };
  });

  useEffect(() => {
    if (auth.kind === "checking") void checkSession().then(setAuth);
  }, [auth.kind]);

  if (auth.kind === "checking") {
    return (
      <div className="login">
        <div className="login-loading" aria-busy="true">
          <BrandMark size={44} />
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }
  if (auth.kind === "signedOut") {
    return (
      <Login
        notice={auth.error}
        setupRequired={auth.setupRequired}
        onSignedIn={(c) => {
          // Only the admin-token flow stores anything; a cookie session keeps no secret in the browser.
          saveConnection(c.token ? c : null);
          setAuth({ kind: "signedIn", conn: c });
        }}
      />
    );
  }
  const { conn } = auth;
  return (
    <Shell
      conn={conn}
      onUnauthorized={() => {
        // The session expired or was signed out from another device.
        if (!conn.token) setAuth({ kind: "checking" });
      }}
      onSignOut={async () => {
        if (conn.token) saveConnection(null);
        else await createApi(conn).logout().catch(() => {});
        setAuth({ kind: "checking" });
      }}
    />
  );
}
// --- end auth ---

/**
 * Navigation, data-driven: the sidebar (desktop), the bottom tab bar and its "More"
 * sheet (phone) are all built from NAV. To add a page, add ONE entry here, e.g.
 *
 *   { key: "today", label: "Today", icon: "today", group: "Work", mobilePrimary: true },
 *
 * and a `case "today":` in Shell's switch below that renders the page. `key` is the
 * hash route (#/today); `icon` is a name from icons.tsx (today, drive and bell exist
 * already); `group` is the sidebar heading (groups appear in NAV order, a new name
 * makes a new group); `mobilePrimary` puts it in the phone tab bar (at most 4, then
 * "More"; everything else goes in the More sheet). A badge count goes in `badges`.
 */
export type NavItem = { key: string; label: string; icon: IconName; group: string; mobilePrimary?: boolean };

export const NAV: NavItem[] = [
  { key: "inbox", label: "Inbox", icon: "inbox", group: "Work", mobilePrimary: true },
  { key: "today", label: "Today", icon: "today", group: "Work", mobilePrimary: true },
  { key: "approvals", label: "Approvals", icon: "approvals", group: "Work", mobilePrimary: true },
  { key: "chat", label: "Chat", icon: "chat", group: "Work", mobilePrimary: true },
  { key: "notifications", label: "Notifications", icon: "bell", group: "Work" },
  { key: "drive", label: "Drive", icon: "drive", group: "Work" },
  { key: "social", label: "Social", icon: "social", group: "Business" },
  { key: "org", label: "Org", icon: "org", group: "Business" },
  { key: "brain", label: "Brain", icon: "brain", group: "Knowledge" },
  { key: "accounts", label: "Accounts", icon: "link", group: "System" },
  { key: "devices", label: "Devices", icon: "devices", group: "System" },
  { key: "settings", label: "Settings", icon: "settings", group: "System" },
  { key: "notification-settings", label: "Notification settings", icon: "bell", group: "System" },
];

/** Routes without their own nav entry, and the entry they highlight. */
const PARENT: Record<string, string> = { task: "inbox", briefing: "notifications" };

/** Routes that render their own full-screen layout: no sidebar, top bar or tab bar. */
const FULL_SCREEN = new Set(["drive"]);

const PHONE = "(max-width: 759.98px)";

function NavLink({ item, active, badge, onClick }: { item: NavItem; active: boolean; badge?: number; onClick?: () => void }) {
  return (
    <a href={`#/${item.key}`} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={onClick}>
      <Icon name={item.icon} />
      <span className="nav-text">{item.label}</span>
      {badge ? (
        <span className="badge" aria-label={`${badge} pending`}>
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </a>
  );
}

function Shell({ conn, onSignOut, onUnauthorized }: { conn: Connection; onSignOut: () => void; onUnauthorized: () => void }) {
  const api = useMemo(() => createApi(conn, onUnauthorized), [conn]);
  const feed = useMemo(() => new LiveFeed(api), [api]);
  const [online, setOnline] = useState(false);
  const [page, id] = useRoute();
  const [theme, setTheme] = useTheme();
  const phone = useMedia(PHONE);
  const [moreOpen, setMoreOpen] = useState(false);
  const install = useInstall();
  const [verticals, setVerticals] = useState<Record<string, VerticalInfo>>({});

  useEffect(() => {
    feed.onStatus = setOnline;
    return () => feed.close();
  }, [feed]);
  useEffect(() => {
    api
      .verticals()
      .then((vs) => setVerticals(Object.fromEntries(vs.map((v) => [v.id, { id: v.id, name: v.name, color: v.color }]))))
      .catch(() => {});
  }, [api]);
  // Close the "More" sheet on navigation.
  useEffect(() => setMoreOpen(false), [page, id]);

  const stats = useLoad(api.stats, feed, (m) => m.type === "proposal.updated" || m.type === "task.updated");
  const pending = stats.data?.pendingApprovals ?? 0;
  const unread = useUnread(api, feed, page);
  /**
   * Badge counts by nav key. The notifications page adds its unread count here
   * (`notifications: unread`), which also badges the header bell.
   */
  const badges: Record<string, number> = { approvals: pending, notifications: unread };

  let body;
  switch (page) {
    case "today":
      body = <Today api={api} feed={feed} />;
      break;
    // Drive mode is full screen (FULL_SCREEN): no nav, nothing to read (see pages/Drive.tsx).
    case "drive":
      body = <Drive api={api} feed={feed} />;
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
    case "task":
      body = <TaskView api={api} feed={feed} id={id!} />;
      break;
    case "approvals":
      body = <Approvals api={api} feed={feed} id={id} />;
      break;
    case "chat":
      body = <Chat api={api} feed={feed} />;
      break;
    case "social":
      body = <Social api={api} feed={feed} />;
      break;
    case "brain":
      body = <Brain api={api} path={id ? decodeURIComponent(id) : undefined} />;
      break;
    case "org":
      body = <Org api={api} feed={feed} />;
      break;
    case "accounts":
      body = <Connections api={api} feed={feed} />;
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

  const activeKey = PARENT[page ?? ""] ?? (NAV.some((n) => n.key === page) ? page! : "inbox");
  const current = NAV.find((n) => n.key === activeKey);
  const primary = NAV.filter((n) => n.mobilePrimary).slice(0, 4);
  const rest = NAV.filter((n) => !primary.includes(n));
  const groups = [...new Set(NAV.map((n) => n.group))];
  const spend = stats.data ? usd(stats.data.costTodayUsd) : null;

  if (FULL_SCREEN.has(page ?? "")) return <VerticalsContext.Provider value={verticals}>{body}</VerticalsContext.Provider>;

  return (
    <VerticalsContext.Provider value={verticals}>
      <div className={`shell ${phone ? "is-phone" : "is-desktop"} page-${page || "inbox"}`}>
        {!phone && (
          <aside className="sidebar">
            <a className="brand" href="#/inbox">
              <BrandMark />
              <span>Command Centre</span>
            </a>
            <nav className="nav" aria-label="Main">
              {groups.map((g) => (
                <div key={g} className="nav-group">
                  <div className="nav-label">{g}</div>
                  {NAV.filter((n) => n.group === g).map((n) => (
                    <NavLink key={n.key} item={n} active={n.key === activeKey} badge={badges[n.key]} />
                  ))}
                </div>
              ))}
            </nav>
            {spend && (
              <div className="sidebar-foot small">
                <span className="muted">Spent today</span>
                <strong>{spend}</strong>
              </div>
            )}
          </aside>
        )}
        <div className="column">
          <header className="topbar">
            {phone ? (
              <a className="brand" href="#/inbox" aria-label="Command Centre, go to Inbox">
                <BrandMark size={28} />
                <span>{page === "task" ? "Task" : (current?.label ?? "Command Centre")}</span>
              </a>
            ) : (
              <div className="crumbs small">
                <span className="muted">{current?.group}</span>
                <Icon name="chevron" size={14} className="muted" />
                {page === "task" ? (
                  <>
                    <a href="#/inbox">Inbox</a>
                    <Icon name="chevron" size={14} className="muted" />
                    <strong>Task</strong>
                  </>
                ) : (
                  <strong>{current?.label}</strong>
                )}
              </div>
            )}
            <div className="topbar-end">
              <a
                href="#/notifications"
                className={`bell icon-link ${activeKey === "notifications" ? "active" : ""}`}
                aria-label={`Notifications, ${unread} unread`}
                title="Notifications"
              >
                <Icon name="bell" />
                {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
              </a>
              <span className="live" title={online ? "Live" : "Reconnecting"} role="status" aria-label={online ? "Live" : "Reconnecting"}>
                <span className={`dot ${online ? "on" : ""}`} />
                {!phone && <span className="small muted">{online ? "Live" : "Reconnecting…"}</span>}
              </span>
              {phone ? <ThemeCycle value={theme} onChange={setTheme} /> : <ThemeToggle value={theme} onChange={setTheme} />}
            </div>
          </header>
          <main className="main">
            {phone && install.showBanner && page !== "settings" && (
              <div className="install-banner card" role="region" aria-label="Install app">
                <Icon name="install" />
                <div className="grow">
                  <strong>Install Command Centre</strong>
                  <div className="small muted">Its own icon, full screen, faster to open.</div>
                </div>
                <button type="button" className="primary small" onClick={() => void install.install()}>
                  Install
                </button>
                <button type="button" className="ghost icon-btn" aria-label="Not now" onClick={install.dismissBanner}>
                  <Icon name="close" />
                </button>
              </div>
            )}
            {body}
          </main>
        </div>
        {phone && (
          <nav className="tabbar" aria-label="Main">
            {primary.map((n) => (
              <NavLink key={n.key} item={n} active={!moreOpen && n.key === activeKey} badge={badges[n.key]} />
            ))}
            <button
              type="button"
              className={moreOpen || !primary.some((n) => n.key === activeKey) ? "active" : ""}
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
              onClick={() => setMoreOpen((o) => !o)}
            >
              <Icon name="more" />
              <span className="nav-text">More</span>
              {rest.some((n) => badges[n.key]) && <span className="badge dot-badge" aria-hidden="true" />}
            </button>
          </nav>
        )}
        {phone && moreOpen && (
          <MoreSheet items={rest} activeKey={activeKey} badges={badges} onClose={() => setMoreOpen(false)}>
            <div className="sheet-row">
              <span className="small muted">Theme</span>
              <ThemeToggle value={theme} onChange={setTheme} />
            </div>
            {install.canInstall && (
              <div className="sheet-row">
                <span className="small muted">App</span>
                <button type="button" className="primary small" onClick={() => void install.install()}>
                  <Icon name="install" /> Install app
                </button>
              </div>
            )}
          </MoreSheet>
        )}
      </div>
    </VerticalsContext.Provider>
  );
}

/** The phone's "More" sheet: every destination not in the tab bar. */
function MoreSheet({
  items,
  activeKey,
  badges,
  onClose,
  children,
}: {
  items: NavItem[];
  activeKey: string;
  badges: Record<string, number>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".sheet-grid a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label="More" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>More</strong>
          <button type="button" className="ghost icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <nav className="sheet-grid" aria-label="More pages">
          {items.map((n) => (
            <NavLink key={n.key} item={n} active={n.key === activeKey} badge={badges[n.key]} onClick={onClose} />
          ))}
        </nav>
        {children}
      </div>
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
