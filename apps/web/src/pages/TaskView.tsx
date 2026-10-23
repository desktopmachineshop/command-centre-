import type { AgentMessage } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago, usd } from "../format";
import { type LiveFeed, useLive, useLoad } from "../live";
import { ProposalCard } from "./Approvals";
import { Transcript } from "./Transcript";

export function TaskView({ api, feed, id }: { api: Api; feed: LiveFeed; id: string }) {
  const { data, error } = useLoad(
    () => api.task(id),
    feed,
    (m) => (m.type === "task.updated" && m.task.id === id) || (m.type === "proposal.updated" && m.proposal.taskId === id),
    [id],
  );
  // Messages streamed while the run is in progress, before they are in the loaded detail.
  const [live, setLive] = useState<Record<string, AgentMessage[]>>({});
  useLive(feed, (m) => {
    if (m.type === "run.message" && m.taskId === id) setLive((s) => ({ ...s, [m.runId]: [...(s[m.runId] ?? []), m.message] }));
  });

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { task, runs, proposals } = data;
  const liveOnly = Object.keys(live).filter((runId) => !runs.some((r) => r.id === runId));

  return (
    <section>
      <div className="row between">
        <span className="tag">{task.vertical}</span>
        <span className={`status ${task.status}`}>{task.status.replace("_", " ")}</span>
      </div>
      <h2 className="prewrap">{task.prompt}</h2>
      <p className="muted small">
        {task.intent} · {task.route} · urgency {task.urgency.toFixed(1)} · {ago(task.createdAt)}
      </p>

      {proposals.length > 0 && (
        <>
          <h3>Proposed actions</h3>
          {proposals.map((p) => (
            <ProposalCard key={p.id} api={api} proposal={p} />
          ))}
        </>
      )}

      {runs.map((run) => (
        <div key={run.id} className="card">
          <div className="row between small">
            <span>
              {run.runner} · <span className={`status ${run.status}`}>{run.status}</span>
            </span>
            <span className="muted">{usd(run.costUsd)}</span>
          </div>
          <Transcript messages={run.messages.length ? run.messages : (live[run.id] ?? [])} />
          {run.error && <p className="error">{run.error}</p>}
        </div>
      ))}
      {liveOnly.map((runId) => (
        <div key={runId} className="card">
          <Transcript messages={live[runId]!} />
        </div>
      ))}
    </section>
  );
}
