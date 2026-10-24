import type { AgentMessage } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago, usd } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLive, useLoad } from "../live";
import { ErrorBanner, Skeleton, Status, VTag } from "../ui";
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
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  useLive(feed, (m) => {
    if (m.type === "run.message" && m.taskId === id) setLive((s) => ({ ...s, [m.runId]: [...(s[m.runId] ?? []), m.message] }));
  });

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <Skeleton rows={2} />;
  const { task, runs, proposals } = data;
  const liveOnly = Object.keys(live).filter((runId) => !runs.some((r) => r.id === runId));
  const canRetry = task.status === "failed" || task.status === "deferred";
  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retry(task.id);
    } catch (e) {
      setRetryError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section>
      <a className="back-link" href="#/inbox">
        <Icon name="back" size={16} /> Inbox
      </a>
      <div className="card">
        <div className="task-head">
          <VTag id={task.vertical} />
          <Status value={task.status} />
        </div>
        <h2 className="prewrap task-prompt">{task.prompt}</h2>
        <div className="meta">
          {task.role && <span className="role">{task.role}</span>}
          <span>{task.intent}</span>
          <span>{task.route}</span>
          <span>urgency {task.urgency.toFixed(1)}</span>
          <span>{ago(task.createdAt)}</span>
        </div>
        {task.note && <p className={`small note status ${task.status}`}>{task.note}</p>}
        {task.duplicateOf && (
          <p className="small">
            <a href={`#/task/${task.duplicateOf}`}>Open the original task</a>
          </p>
        )}
        {canRetry && (
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="primary" disabled={retrying} onClick={retry}>
              <Icon name="refresh" size={16} />
              {task.status === "deferred" ? "Run now" : "Retry"}
            </button>
            {task.status === "deferred" && <span className="muted small">Ignores the daily budget for this one run.</span>}
          </div>
        )}
        {retryError && <ErrorBanner>{retryError}</ErrorBanner>}
      </div>

      {proposals.length > 0 && (
        <>
          <div className="section-title">
            <h3>Proposed actions</h3>
          </div>
          {proposals.map((p) => (
            <ProposalCard key={p.id} api={api} proposal={p} />
          ))}
        </>
      )}

      {(runs.length > 0 || liveOnly.length > 0) && (
        <div className="section-title">
          <h3>Runs</h3>
        </div>
      )}
      {runs.map((run) => (
        <div key={run.id} className="card run-card">
          <div className="run-head small">
            <span className="row">
              <strong>{run.runner}</strong> <Status value={run.status} />
            </span>
            <span className="muted">{usd(run.costUsd)}</span>
          </div>
          <div className="run-body">
            <Transcript messages={run.messages.length ? run.messages : (live[run.id] ?? [])} />
            {run.error && <ErrorBanner>{run.error}</ErrorBanner>}
          </div>
        </div>
      ))}
      {liveOnly.map((runId) => (
        <div key={runId} className="card run-card">
          <div className="run-head small">
            <span className="row">
              <Status value="running" />
            </span>
          </div>
          <div className="run-body">
            <Transcript messages={live[runId]!} />
          </div>
        </div>
      ))}
    </section>
  );
}
