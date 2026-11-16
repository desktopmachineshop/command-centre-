import { type AgentMessage, cardRefs, isStopped, type Proposal, type Task } from "@cc/core";
import { useEffect, useState } from "react";
import type { Api, ChatFile, TaskDetail } from "../api";
import { ago, askText, emailAsk, readableEmailBody, usd } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLive, useLoad } from "../live";
import { ErrorBanner, Skeleton, TaskTag } from "../ui";
import { ProposalList } from "./Approvals";
import { sourceLabel } from "./Activity";
import { runOpener, Transcript } from "./Transcript";
import { useStickToBottom } from "../scroll";
import { ErrorReport, type ReportFacts } from "../copy";
import { AttachedFiles, chatFilesOf, Composer } from "../composer";
import { ReadAloudControl, useReadAloud } from "../voice/readAloud";
import { Markdown } from "../markdown";

/** A task's state in the words Dave would use. */
export function statusWords(task: Pick<Task, "status" | "note">): string {
  if (isStopped(task)) return "Stopped";
  return { queued: "Waiting to start", running: "Working on it", awaiting_approval: "Waiting for your approval", done: "Done", failed: "Didn't finish", dropped: "Not run", deferred: "Held by the daily budget" }[task.status];
}

/** The kinds of record card (odoo.order) an agent's messages already show. */
export function cardKindsIn(messages: AgentMessage[]): string[] {
  const kinds = new Set<string>();
  for (const m of messages) {
    if (m.type !== "text") continue;
    for (const block of m.text.matchAll(/^ {0,3}(`{3,}|~{3,})card\s*\n([\s\S]*?)^ {0,3}\1\s*$/gm)) {
      for (const ref of cardRefs(block[2]!)) kinds.add(ref.split(":")[0]!);
    }
  }
  return [...kinds];
}

type Run = TaskDetail["runs"][number];
export interface ThreadStep {
  run: Run;
  /** Who started this run after the first: Dave's reply, or a role reporting back. */
  opener: ReturnType<typeof runOpener>;
  /** The actions proposed during this run. */
  proposals: Proposal[];
}

/**
 * A task as a conversation: its runs in order, each with what started it and the actions it
 * proposed (those made from its start until the next run starts; anything earlier goes with
 * the first run). Pure.
 */
export function threadOf(runs: Run[], proposals: Proposal[]): ThreadStep[] {
  const ordered = [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return ordered.map((run, i) => {
    const from = i === 0 ? -Infinity : Date.parse(run.startedAt);
    const to = i + 1 < ordered.length ? Date.parse(ordered[i + 1]!.startedAt) : Infinity;
    return { run, opener: runOpener(run.messages), proposals: proposals.filter((p) => Date.parse(p.createdAt) >= from && Date.parse(p.createdAt) < to) };
  });
}

/**
 * One task, read as the conversation it is: what was asked (or came in), then each answer with
 * the actions it led to, each reply and what came back, down to a box to carry it on. What the
 * agent did along the way is one folded line per answer; the task's workings (role, cost, the
 * handover note) are under Details.
 */
export function TaskView({ api, feed, id }: { api: Api; feed: LiveFeed; id: string }) {
  const { data, error } = useLoad(
    () => api.task(id),
    feed,
    (m) => (m.type === "task.updated" && m.task.id === id) || (m.type === "proposal.updated" && m.proposal.taskId === id),
    [id],
  );
  // Messages streamed since the detail was last loaded: shown after the loaded ones while a run is
  // in progress, and dropped at each load (which has them).
  const [live, setLive] = useState<Record<string, AgentMessage[]>>({});
  useEffect(() => setLive({}), [data]);
  // Reading the task reads what the notification centre said about it. Again when it changes
  // state, so the answer that arrives while it is open isn't left unread.
  useEffect(() => {
    void api.markTaskRead(id).catch(() => {});
  }, [api, id, data?.task.status]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** A reply just sent, shown until the run that answers it appears. */
  const [sent, setSent] = useState<{ text: string; runs: number } | null>(null);
  const readAloud = useReadAloud(api);
  useLive(feed, (m) => {
    if (m.type === "run.message" && m.taskId === id) {
      if (m.message.type === "text") readAloud.offer(m.message.text);
      setLive((s) => ({ ...s, [m.runId]: [...(s[m.runId] ?? []), m.message] }));
    }
  });

  // The latest answer is at the bottom, above the reply box: open there and follow it as it streams.
  const streamed = Object.values(live).reduce((n, m) => n + m.length, 0);
  useStickToBottom(`${data?.runs.length ?? 0}:${streamed}:${data?.task.status ?? ""}:${sent ? 1 : 0}`, !!data);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <Skeleton rows={2} />;
  const { task, runs, proposals, event } = data;
  const thread = threadOf(runs, proposals);
  const orphans = proposals.filter((p) => !thread.some((s) => s.proposals.includes(p)));
  const liveOnly = Object.keys(live).filter((runId) => !runs.some((r) => r.id === runId));
  const working = task.status === "running" || task.status === "queued";
  const canRetry = task.status === "failed" || task.status === "deferred";
  const fromChat = event?.source === "chat";
  const cost = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const pendingSent = sent && runs.length <= sent.runs ? sent : null;

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await what();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="thread">
      <div className="thread-head">
        <a className="back-link" href="#/activity" onClick={(e) => { if (history.length > 1) { e.preventDefault(); history.back(); } }}>
          <Icon name="back" size={16} /> Back
        </a>
        <span className="row small thread-state">
          <TaskTag task={task} />
          <span className={`status ${task.status}`}>{statusWords(task)}</span>
        </span>
      </div>

      <div className="turns">
        {/* What started it: Dave's own message, or what came in. */}
        {fromChat ? (
          <div className="bubble me">
            <span className="prewrap">{askText(task.prompt)}</span>
            <AttachedFiles files={chatFilesOf(event?.payload)} />
            <div className="bubble-when small">{ago(task.createdAt)}</div>
          </div>
        ) : (
          <div className="card thread-origin">
            <p className="small muted">
              {sourceLabel(event?.source)} · {ago(task.createdAt)}
            </p>
            <TaskAsk prompt={task.prompt} />
          </div>
        )}
        {task.duplicateOf && (
          <p className="small">
            This repeated work already in hand, so it wasn't run again. <a href={`#/task/${task.duplicateOf}`}>Open the original</a>
          </p>
        )}

        {thread.map(({ run, opener, proposals: made }, i) => {
          const running = run.status === "running";
          const last = i === thread.length - 1;
          return (
            <div key={run.id} className="turn">
              {opener?.from === "dave" && <div className="bubble me prewrap">{opener.text}</div>}
              {opener?.from === "role" && (
                <details className="thread-report">
                  <summary className="small muted">{opener.kind === "report" ? `Report back from ${opener.author}` : `Follow-up from ${opener.author}`}</summary>
                  <Markdown className="msg text" text={opener.text} />
                </details>
              )}
              <div className="bubble agent">
                <Transcript messages={running ? [...run.messages, ...(live[run.id] ?? [])] : run.messages} readAloud={readAloud} id={run.id} working={running} />
                {run.error && !(last && isStopped(task)) && (
                  <ErrorReport
                    title="This didn't finish"
                    error={run.error}
                    facts={[...taskFacts(task), ["Run", run.id], ["Runner", run.runner], ["Run started", run.startedAt], ["Run finished", run.finishedAt], ["Cost", usd(run.costUsd)]]}
                  />
                )}
                <ProposalList api={api} proposals={made} shownKinds={cardKindsIn(run.messages)} />
              </div>
            </div>
          );
        })}
        {liveOnly.map((runId) => (
          <div key={runId} className="turn">
            <div className="bubble agent">
              <Transcript messages={live[runId]!} readAloud={readAloud} id={runId} working />
            </div>
          </div>
        ))}
        {orphans.length > 0 && <ProposalList api={api} proposals={orphans} />}
        {pendingSent && <div className="bubble me prewrap">{pendingSent.text}</div>}
        {(pendingSent || (working && !thread.some((s) => s.run.status === "running") && !liveOnly.length)) && (
          <div className="bubble agent">
            <p className="msg system muted small working-line">{task.status === "queued" || pendingSent ? "Waiting to start…" : "Working on it…"}</p>
          </div>
        )}
        {runs.length === 0 && !working && task.status !== "failed" && task.status !== "deferred" && (
          <p className="small muted thread-note">
            {task.status === "dropped" ? "This wasn't run." : "This was filed without an agent run: nothing needed doing. Reply below to have the assistant look at it."}
          </p>
        )}

        {/* How it stands, when that needs saying. */}
        {isStopped(task) && <p className="small muted thread-note">You stopped this. Reply to carry on, or retry it.</p>}
        {task.status === "failed" && !isStopped(task) && !runs.some((r) => r.error) && (
          <ErrorReport title="This didn't finish" error={task.note ?? "The run failed without a message."} facts={taskFacts(task)} />
        )}
        {task.status === "deferred" && <p className="small note status deferred thread-note">{task.note ?? "Held by a daily budget until after midnight."}</p>}
        {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
        {(working || task.status === "deferred" || canRetry) && (
          <div className="row wrap thread-actions">
            {(working || task.status === "deferred") && (
              <button type="button" className="danger" disabled={busy} onClick={() => void act(() => api.stopTask(task.id))} title="Stop this, and any work it handed on">
                <Icon name="stop" size={16} /> Stop
              </button>
            )}
            {canRetry && (
              <button type="button" className="primary" disabled={busy} onClick={() => void act(() => api.retry(task.id))}>
                <Icon name="refresh" size={16} /> {task.status === "deferred" ? "Run now" : "Try again"}
              </button>
            )}
            {task.status === "deferred" && <span className="muted small">Run now ignores the daily budget for this one run.</span>}
          </div>
        )}

        <details className="thread-details">
          <summary className="small muted">Details</summary>
          <dl className="small">
            <dt>Handled by</dt>
            <dd>{task.role ?? "the business's lead"}</dd>
            <dt>Came from</dt>
            <dd>{sourceLabel(event?.source)}{event?.kind ? ` (${event.kind})` : ""}</dd>
            <dt>Sorted as</dt>
            <dd>{task.intent}, {task.route}, urgency {task.urgency.toFixed(1)}</dd>
            <dt>Started</dt>
            <dd>{new Date(task.createdAt).toLocaleString()}</dd>
            <dt>Runs</dt>
            <dd>{runs.length ? runs.map((r) => `${r.runner} ${r.status}${r.costUsd != null ? ` ${usd(r.costUsd)}` : ""}`).join(" · ") : "none"}</dd>
            <dt>Cost</dt>
            <dd>{usd(cost)}</dd>
            <dt>Task</dt>
            <dd><code>{task.id}</code></dd>
          </dl>
          <ReadAloudControl readAloud={readAloud} />
          {data.handover && (
            <details className="handover">
              <summary className="small muted">Handover note</summary>
              <p className="small muted">What any agent picking this up starts from (updated {ago(data.handover.at)}).</p>
              <Markdown className="msg text" text={data.handover.text} />
            </details>
          )}
        </details>
      </div>

      {/* The server takes a reply once the task has answered (done, waiting for approval, or failed). */}
      {(task.status === "done" || task.status === "awaiting_approval" || task.status === "failed") && !pendingSent ? (
        <ReplyBox api={api} taskId={task.id} onSent={(text) => setSent({ text, runs: runs.length })} />
      ) : working || pendingSent ? (
        <p className="small muted thread-note">You can reply as soon as it has answered.</p>
      ) : null}
    </section>
  );
}

/**
 * Carry the conversation on: answer its question, change the plan or ask for more. The task runs
 * again from where it was.
 */
function ReplyBox({ api, taskId, onSent }: { api: Api; taskId: string; onSent: (text: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (message: string, files: ChatFile[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.replyToTask(taskId, message, false, files.map((f) => f.id));
      setText("");
      onSent(message);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-reply" data-help-pane="inbox.task.reply">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Composer
        api={api}
        value={text}
        onChange={setText}
        onSend={send}
        busy={busy}
        className="reply-box"
        label="Reply"
        placeholder="Reply: answer its question, change the plan, or ask for more"
      />
    </div>
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
