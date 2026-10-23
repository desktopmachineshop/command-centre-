import type { Api } from "../api";
import { ago } from "../format";
import { type LiveFeed, useLoad } from "../live";

/** Worker nodes (desktop / laptop) and the heavy jobs dispatched to them. */
export function Devices({ api, feed }: { api: Api; feed: LiveFeed }) {
  const nodes = useLoad(api.nodes, feed, (m) => m.type === "node.updated");
  const jobs = useLoad(api.jobs, feed, (m) => m.type === "job.updated");

  return (
    <section>
      <h2>Devices</h2>
      {nodes.data?.length === 0 && <p className="muted">No worker nodes yet. Start the desktop app on your PC to add one.</p>}
      <ul className="list">
        {nodes.data?.map((n) => (
          <li key={n.id} className="item">
            <div className="row between">
              <span className="title">{n.name}</span>
              <span className={`dot ${n.online ? "on" : ""}`} />
            </div>
            <div className="muted small">
              {n.capabilities.join(", ") || "no capabilities"} · seen {ago(n.lastSeen)}
            </div>
          </li>
        ))}
      </ul>
      <h3>Jobs</h3>
      {jobs.data?.length === 0 && <p className="muted">No jobs.</p>}
      <ul className="list">
        {jobs.data?.map((j) => (
          <li key={j.id} className="item">
            <div className="row between">
              <span className="title">{j.kind}</span>
              <span className={`status ${j.status}`}>{j.status}</span>
            </div>
            <div className="muted small">
              needs {j.requires.join(", ") || "anything"}
              {j.nodeId && ` · on ${j.nodeId}`}
              {j.progress != null && ` · ${Math.round(j.progress * 100)}%`} · {ago(j.updatedAt)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
