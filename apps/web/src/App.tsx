import { useEffect, useMemo, useState } from "react";
import { type Connection, createApi, loadConnection, saveConnection } from "./api";
import { usd } from "./format";
import { LiveFeed, useLoad } from "./live";
import { Approvals } from "./pages/Approvals";
import { Brain } from "./pages/Brain";
import { Chat } from "./pages/Chat";
import { Devices } from "./pages/Devices";
import { Inbox } from "./pages/Inbox";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";
import { TaskView } from "./pages/TaskView";
import { go, useRoute } from "./router";

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
