import type { AgentMessage } from "@cc/core";
import { useState } from "react";
import type { Api, ChatFile } from "../api";
import { ago, askText, emailAsk, readableEmailBody, usd } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLive, useLoad } from "../live";
import { ErrorBanner, Skeleton, Status, VTag } from "../ui";
import { ProposalCard } from "./Approvals";
import { Transcript } from "./Transcript";
import { useStickToBottom } from "../scroll";
import { ErrorReport, type ReportFacts } from "../copy";
import { AttachedFiles, chatFilesOf, Composer } from "../composer";

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
  /** Narrow screens: Conversation or Actions. Wide screens show both side by side. */
  const [tab, setTab] = useState<"conversation" | "actions">("conversation");
  const [retryError, setRetryError] = useState<string | null>(null);
  useLive(feed, (m) => {
    if (m.type === "run.message" && m.taskId === id) setLive((s) => ({ ...s, [m.runId]: [...(s[m.runId] ?? []), m.message] }));
  });

  // The latest answer is at the bottom, above the reply box: open there and follow it as it streams.
  const streamed = Object.values(live).reduce((n, m) => n + m.length, 0);
  useStickToBottom(`${data?.runs.length ?? 0}:${streamed}:${data?.task.status ?? ""}:${tab}`, !!data && tab === "conversation");

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <Skeleton rows={2} />;
  const { task, runs, proposals } = data;
  const liveOnly = Object.keys(live).filter((runId) => !runs.some((r) => r.id === runId));
  const canRetry = task.status === "failed" || task.status === "deferred";
  const pending = proposals.filter((p) => p.status === "pending").length;
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
      {proposals.length > 0 && (
        <div className="task-tabs" role="tablist" aria-label="Task view">
          <button type="button" role="tab" aria-selected={tab === "conversation"} className={tab === "conversation" ? "on" : ""} onClick={() => setTab("conversation")}>
            Conversation
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "actions"}
            className={tab === "actions" ? "on" : ""}
            onClick={() => {
              setTab("actions");
              window.scrollTo({ top: 0 });
            }}
          >
            Actions
            {pending > 0 && <span className="badge">{pending}</span>}
          </button>
        </div>
      )}
      <div className={`task-layout ${proposals.length ? "has-actions" : ""} show-${tab}`}>
      <div className="task-main">
      <div className="card">
        <div className="task-head">
          <VTag id={task.vertical} />
          <Status value={task.status} />
        </div>
        <TaskAsk prompt={task.prompt} />
        <AttachedFiles files={chatFilesOf(data.event?.payload)} />
        <div className="meta">
          {task.role && <span className="role">{task.role}</span>}
          <span>{task.intent}</span>
          <span>{task.route}</span>
          <span>urgency {task.urgency.toFixed(1)}</span>
          <span>{ago(task.createdAt)}</span>
        </div>
        {task.note &&
          (task.status === "failed" ? (
            <ErrorReport title="Task failed" error={task.note} facts={taskFacts(task)} />
          ) : (
            <p className={`small note status ${task.status}`}>{task.note}</p>
          ))}
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

      {(runs.length > 0 || liveOnly.length > 0) && (
        <div className="section-title">
          <h3>Conversation</h3>
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
            {run.error && (
              <ErrorReport
                title="Run failed"
                error={run.error}
                facts={[...taskFacts(task), ["Run", run.id], ["Runner", run.runner], ["Run started", run.startedAt], ["Run finished", run.finishedAt], ["Cost", usd(run.costUsd)]]}
              />
            )}
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
      {(task.status === "done" || task.status === "awaiting_approval" || task.status === "failed") && <ReplyBox api={api} taskId={task.id} />}
      </div>
      {proposals.length > 0 && (
        <aside className="task-actions" aria-label="Proposed actions">
          <div className="section-title">
            <h3>Proposed actions</h3>
            {pending > 0 && <span className="muted small">{pending} waiting for you</span>}
          </div>
          {/* Waiting ones first: they're what this column is for. */}
          {[...proposals]
            .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"))
            .map((p) => (
              <ProposalCard key={p.id} api={api} proposal={p} />
            ))}
        </aside>
      )}
      </div>
    </section>
  );
}

/**
 * Talk back to the agent on this task: answer its question, change its plan or
 * ask for more. The task runs again, resuming the agent's earlier session.
 * The same message box as the Chat page, mic included.
 */
function ReplyBox({ api, taskId }: { api: Api; taskId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (message: string, files: ChatFile[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.replyToTask(taskId, message, false, files.map((f) => f.id));
      setText("");
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Composer
        api={api}
        value={text}
        onChange={setText}
        onSend={send}
        busy={busy}
        className="reply-box"
        label="Reply to the agent"
        placeholder="Reply to the agent: answer its question, change the plan, or ask for something else"
      />
    </>
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

/** What identifies a task in an error report. */
function taskFacts(task: import("@cc/core").Task): ReportFacts {
  return [
    ["Task", task.id],
    ["Business", task.vertical],
    ["Role", task.role],
    ["Status", task.status],
    ["Created", task.createdAt],
    ["Asked", askText(task.prompt).split("\n")[0]?.slice(0, 200)],
  ];
}
