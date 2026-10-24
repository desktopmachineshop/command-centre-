import type { Api } from "../api";
import { ago } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLoad } from "../live";
import { Empty, ErrorBanner, PageHead, Skeleton, Status } from "../ui";

/** Worker nodes (desktop / laptop) and the heavy jobs dispatched to them. */
export function Devices({ api, feed }: { api: Api; feed: LiveFeed }) {
  const nodes = useLoad(api.nodes, feed, (m) => m.type === "node.updated");
  const jobs = useLoad(api.jobs, feed, (m) => m.type === "job.updated");

  return (
    <section>
      <PageHead title="Devices" sub="Worker PCs that run ffmpeg, GPU and local Claude Code jobs." />
      {nodes.error && <ErrorBanner>{nodes.error}</ErrorBanner>}
      {!nodes.data && !nodes.error && <Skeleton rows={1} />}
      {nodes.data?.length === 0 && <Empty icon="devices">No worker nodes yet. Start the desktop app on your PC to add one.</Empty>}
      <ul className="list">
        {nodes.data?.map((n) => (
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
