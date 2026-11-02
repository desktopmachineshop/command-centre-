import type { AgentMessage } from "@cc/core";
import { type FormEvent, useState } from "react";
import type { Api } from "../api";
import { ago, askText, emailAsk, readableEmailBody, usd } from "../format";
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
        <TaskAsk prompt={task.prompt} />
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

      {(task.status === "done" || task.status === "awaiting_approval" || task.status === "failed") && <ReplyBox api={api} taskId={task.id} />}

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

/**
 * Talk back to the agent on this task: answer its question, change its plan or
 * ask for more. The task runs again, resuming the agent's earlier session.
 */
function ReplyBox({ api, taskId }: { api: Api; taskId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.replyToTask(taskId, text.trim(), false);
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card reply-box" onSubmit={send}>
      <label className="field">
        <span>Reply to the agent</span>
        <textarea value={text} rows={2} placeholder="Answer its question, change the plan, or ask for something else" onChange={(e) => setText(e.target.value)} />
      </label>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          <Icon name="chat" size={16} /> {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

/** What the task is about. An email shows as a quote, apart from the agent's work; automated mail starts folded away. */
function TaskAsk({ prompt }: { prompt: string }) {
  const email = emailAsk(prompt);
  if (!email) return <h2 className="prewrap task-prompt">{askText(prompt)}</h2>;
  const quote = (
    <blockquote className="email-quote">
      <div className="email-quote-head small">
        <div>
          <strong>From</strong> {email.from}
        </div>
        {email.date && (
          <div>
            <strong>Sent</strong> {new Date(email.date).toLocaleString()}
          </div>
        )}
        {email.attachments && (
          <div>
            <strong>Attachments</strong> {email.attachments}
          </div>
        )}
      </div>
      <div className="email-quote-body prewrap">{readableEmailBody(email.body) || "(empty email)"}</div>
    </blockquote>
  );
  return (
    <>
      <h2 className="task-prompt">{email.title}</h2>
      {email.automated ? (
        <details className="email-fold">
          <summary className="muted small">Automated email ({email.automated}). Show it</summary>
          {quote}
        </details>
      ) : (
        quote
      )}
    </>
  );
}
