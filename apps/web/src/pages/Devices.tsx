import { useEffect, useState } from "react";
import { type Api, ApiError, type DesktopDevice } from "../api";
import { ago } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLoad } from "../live";
import { go, useRouteQuery } from "../router";
import { Empty, ErrorBanner, PageHead, Skeleton, Status } from "../ui";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** Worker nodes (desktop / laptop), the desktop app download, linked computers, and the heavy jobs. */
export function Devices({ api, feed }: { api: Api; feed: LiveFeed }) {
  const nodes = useLoad(api.nodes, feed, (m) => m.type === "node.updated");
  const jobs = useLoad(api.jobs, feed, (m) => m.type === "job.updated");
  // A computer links as soon as its worker connects, which also sends node.updated.
  const devices = useLoad(api.desktopDevices, feed, (m) => m.type === "node.updated");
  const linkCode = useRouteQuery().get("link");

  const deviceFor = (nodeId: string) => devices.data?.find((d) => d.nodeId === nodeId);
  const waiting = devices.data?.filter((d) => !d.nodeId || !nodes.data?.some((n) => n.id === d.nodeId)) ?? [];

  return (
    <section>
      <PageHead title="Devices" sub="Worker PCs that run ffmpeg, GPU and local Claude Code jobs." />
      {linkCode && <LinkApproval api={api} code={linkCode} onLinked={devices.reload} />}
      <DesktopDownload api={api} />
      {nodes.error && <ErrorBanner>{nodes.error}</ErrorBanner>}
      {!nodes.data && !nodes.error && <Skeleton rows={1} />}
      {nodes.data?.length === 0 && waiting.length === 0 && (
        <Empty icon="devices">No computers yet. Download the desktop app above and open it on your PC to add one.</Empty>
      )}
      <ul className="list">
        {nodes.data?.map((n) => {
          const device = deviceFor(n.id);
          return (
            <li key={n.id} className="item static device-row">
              <span className="device-icon">
                <Icon name="devices" />
              </span>
              <div className="grow">
                <div className="row between">
                  <span className="title">{n.name}</span>
                  <span className={`presence ${n.online ? "on" : ""}`}>{n.online ? "Online" : "Offline"}</span>
                </div>
                <div className="muted small">
                  {n.capabilities.join(", ") || "no capabilities"} · seen {ago(n.lastSeen)}
                </div>
                {device && <Unlink api={api} device={device} onDone={devices.reload} />}
              </div>
            </li>
          );
        })}
        {waiting.map((d) => (
          <li key={d.id} className="item static device-row">
            <span className="device-icon">
              <Icon name="devices" />
            </span>
            <div className="grow">
              <div className="row between">
                <span className="title">{d.name}</span>
                <span className="presence">Linked</span>
              </div>
              <div className="muted small">Linked {ago(d.createdAt)}, not connected yet</div>
              <Unlink api={api} device={d} onDone={devices.reload} />
            </div>
          </li>
        ))}
      </ul>
      <div className="section-title">
        <h3>Jobs</h3>
      </div>
      {jobs.error && <ErrorBanner>{jobs.error}</ErrorBanner>}
      {jobs.data?.length === 0 && <Empty icon="clock">No jobs.</Empty>}
      <ul className="list">
        {jobs.data?.map((j) => (
          <li key={j.id} className="item static">
            <div className="row between">
              <span className="title">{j.kind}</span>
              <Status value={j.status} />
            </div>
            <div className="muted small">
              needs {j.requires.join(", ") || "anything"}
              {j.nodeId && ` · on ${j.nodeId}`}
              {j.progress != null && ` · ${Math.round(j.progress * 100)}%`} · {ago(j.updatedAt)}
            </div>
            {j.progress != null && j.status === "running" && (
              <div className="progress" role="progressbar" aria-valuenow={Math.round(j.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.round(j.progress * 100)}%` }} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The desktop app opens `#/devices?link=<code>` after you sign in: approve that computer here. */
function LinkApproval({ api, code, onLinked }: { api: Api; code: string; onLinked: () => void }) {
  const [info, setInfo] = useState<{ name: string; code: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "linking" | "linked" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState("loading");
    api
      .desktopLink(code)
      .then((l) => {
        setInfo(l);
        setState(l.approved ? "linked" : "ready");
      })
      .catch((e: Error) => {
        setError(e instanceof ApiError && e.status === 404 ? "This link code has expired. Choose Link this computer in the desktop app's tray menu to start again." : e.message);
        setState("error");
      });
  }, [code]);

  const approve = async () => {
    setState("linking");
    try {
      await api.approveDesktopLink(code);
      setState("linked");
      onLinked();
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="link" />
        <h3>Link a computer</h3>
      </div>
      {state === "loading" && <p className="small muted">Checking the link code…</p>}
      {state === "error" && <p className="error small">{error}</p>}
      {state === "ready" && info && (
        <>
          <p className="small">
            Link <strong>{info.name}</strong> to your command centre? Check the desktop app shows the code <code>{info.code}</code>. Once linked,
            it runs ffmpeg, GPU and Claude Code jobs while the app is open.
          </p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => void approve()}>
              <Icon name="check" /> Link this computer
            </button>
            <button type="button" onClick={() => go("devices")}>
              Cancel
            </button>
          </div>
        </>
      )}
      {state === "linking" && <p className="small muted">Linking…</p>}
      {state === "linked" && (
        <>
          <p className="small">
            <Icon name="check" /> Linked{info ? <> {info.name}</> : null}. The desktop app connects in a few seconds; you can carry on here.
          </p>
          <button type="button" className="small" onClick={() => go("devices")}>
            Done
          </button>
        </>
      )}
    </div>
  );
}

/** Download card for the Windows desktop app, built by the Desktop GitHub workflow. */
function DesktopDownload({ api }: { api: Api }) {
  const [installer, setInstaller] = useState<Awaited<ReturnType<Api["desktopInstaller"]>>["installer"] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .desktopInstaller()
      .then((r) => setInstaller(r.installer))
      .catch((e: Error) => setError(e.message));
  }, []);

  /** An admin-token connection can't authenticate a plain link, so it fetches the file instead. */
  const downloadWithToken = async () => {
    setBusy(true);
    try {
      const blob = await api.desktopDownload();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = installer?.filename ?? "Command Centre setup.exe";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <Icon name="install" />
        <h3>Desktop app for Windows</h3>
      </div>
      <p className="small muted">
        Your command centre in a window, and this PC as a worker for video, GPU and Claude Code jobs. Open it, sign in with your email and password,
        and approve the computer. There's nothing to set up in Railway.
      </p>
      {error && <p className="error small">{error}</p>}
      {installer === undefined && !error && <Skeleton rows={1} />}
      {installer === null && (
        <p className="small muted">
          Not built yet. In GitHub, run <strong>Actions → Desktop → Run workflow</strong>; the download appears here when it finishes.
        </p>
      )}
      {installer && (
        <div className="row wrap between">
          {api.token ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void downloadWithToken()}>
              <Icon name="install" /> {busy ? "Downloading…" : "Download for Windows"}
            </button>
          ) : (
            <a className="button-link primary" href={api.desktopDownloadUrl} download={installer.filename}>
              <Icon name="install" /> Download for Windows
            </a>
          )}
          <span className="small muted">
            Version {installer.version}
            {installer.commit && (
              <>
                {" "}
                (<code>{installer.commit.slice(0, 7)}</code>)
              </>
            )}{" "}
            · {mb(installer.size)} · built {ago(installer.uploadedAt)}
          </span>
        </div>
      )}
      {installer && (
        <p className="small muted">
          Windows may warn that the installer isn't signed: choose <strong>More info → Run anyway</strong>.
        </p>
      )}
    </div>
  );
}

function Unlink({ api, device, onDone }: { api: Api; device: DesktopDevice; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="danger-text small"
      disabled={busy}
      onClick={async () => {
        if (!confirm(`Unlink ${device.name}? It stops taking jobs until you link it again from the desktop app.`)) return;
        setBusy(true);
        try {
          await api.unlinkDesktop(device.id);
          onDone();
        } catch (e) {
          alert((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Unlink
    </button>
  );
}
