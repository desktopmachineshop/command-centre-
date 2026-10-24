import { useEffect, useMemo, useState } from "react";
import { ApiError, COOKIE_SESSION, type Connection, createApi, loadConnection, saveConnection } from "./api";
import { usd } from "./format";
import { LiveFeed, useLoad } from "./live";
import { Approvals } from "./pages/Approvals";
import { Brain } from "./pages/Brain";
import { Chat } from "./pages/Chat";
import { Devices } from "./pages/Devices";
import { Drive } from "./pages/Drive";
import { Inbox } from "./pages/Inbox";
import { Login } from "./pages/Login";
import { Org } from "./pages/Org";
import { Settings } from "./pages/Settings";
import { Social } from "./pages/Social";
import { TaskView } from "./pages/TaskView";
import { go, useRoute } from "./router";

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
        <p className="muted">Loading…</p>
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

const NAV = [
  ["inbox", "Inbox"],
  ["approvals", "Approvals"],
  ["chat", "Chat"],
  ["social", "Social"],
  ["org", "Org"],
  ["brain", "Brain"],
  ["devices", "Devices"],
  ["settings", "Settings"],
] as const;

function Shell({ conn, onSignOut, onUnauthorized }: { conn: Connection; onSignOut: () => void; onUnauthorized: () => void }) {
  const api = useMemo(() => createApi(conn, onUnauthorized), [conn]);
  const feed = useMemo(() => new LiveFeed(api), [api]);
  const [online, setOnline] = useState(false);
  const [page, id] = useRoute();

  useEffect(() => {
    feed.onStatus = setOnline;
    return () => feed.close();
  }, [feed]);

  const stats = useLoad(api.stats, feed, (m) => m.type === "proposal.updated" || m.type === "task.updated");
  const pending = stats.data?.pendingApprovals ?? 0;

  // Drive mode is full screen: no nav, nothing to read (see pages/Drive.tsx).
  if (page === "drive") return <Drive api={api} feed={feed} />;

  let body;
  switch (page) {
    case "task":
      body = <TaskView api={api} feed={feed} id={id!} />;
      break;
    case "approvals":
      body = <Approvals api={api} feed={feed} />;
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
