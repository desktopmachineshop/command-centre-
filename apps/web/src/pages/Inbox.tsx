import { isStopped, type Proposal, type StoredNotification, type Task } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago, askText } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLoad } from "../live";
import { go } from "../router";
import { Empty, ErrorBanner, PageHead, Skeleton, VTag } from "../ui";
import { ProposalCard } from "./Approvals";
import { NotificationMediaView, notificationLinks } from "./Notifications";

/** How long something Dave asked for that didn't finish stays in the Inbox. */
const FAILED_FOR_MS = 48 * 3_600_000;
/** Most approvals drawn in full; the rest are a link to Approvals. */
const MAX_APPROVALS = 5;
/**
 * The kinds of message worth a card: something to act on or that he asked to be told. Digests,
 * orders, social activity and system notes are summaries of automated work: they stay in
 * Notifications and the daily digest.
 */
const IMPORTANT: ReadonlySet<string> = new Set(["alert", "reminder", "quotes", "agent", "briefing"]);
const KIND: Record<string, string> = { alert: "Alert", reminder: "Reminder", quotes: "Quote or supplier", agent: "From your assistant", briefing: "Briefing" };

const DISMISSED_KEY = "cc.inbox.dismissed";
function loadDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-200) : [];
  } catch {
    return [];
  }
}

export interface Waiting {
  approvals: Proposal[];
  /** Things Dave asked for that didn't finish. */
  failed: Task[];
  /** Unread messages that matter. */
  messages: StoredNotification[];
}

/**
 * What goes in the Inbox, from what the server has: pending approvals; tasks Dave asked for (in
 * Chat) that failed in the last two days and weren't stopped by him or dismissed; and unread
 * important messages. Not: approval requests (the approval is already there), a task's progress
 * updates, what is said about a failed task already listed, or anything automated. Pure.
 */
export function waitingOf(input: { approvals: Proposal[]; failedTasks: Task[]; unread: StoredNotification[]; dismissed?: readonly string[]; now?: number }): Waiting {
  const now = input.now ?? Date.now();
  const dismissed = new Set(input.dismissed ?? []);
  const failed = input.failedTasks.filter((t) => t.source === "chat" && !isStopped(t) && !dismissed.has(t.id) && now - Date.parse(t.updatedAt) < FAILED_FOR_MS);
  const failedIds = new Set(input.failedTasks.map((t) => t.id));
  const messages = input.unread.filter((n) => {
    if (!IMPORTANT.has(n.category)) return false;
    const taskId = typeof n.data?.taskId === "string" ? n.data.taskId : null;
    if (taskId && failedIds.has(taskId)) return false;
    return !(n.tag?.startsWith("progress-") && !n.data?.outcome);
  });
  return { approvals: input.approvals, failed, messages };
}

export const waitingCount = (w: Waiting): number => w.approvals.length + w.failed.length + w.messages.length;

/** The Inbox's contents, live. Also what the Inbox's badge counts (App.tsx). */
export function useWaiting(api: Api, feed: LiveFeed) {
  const [dismissed, setDismissed] = useState(loadDismissed);
  const { data, error, reload } = useLoad(
    () => Promise.all([api.proposals("pending"), api.tasks("failed", { feed: "1" }), api.notifications({ unread: true, limit: 100 })]),
    feed,
    (m) => m.type === "task.updated" || m.type === "proposal.updated" || m.type === "notifications.updated",
  );
  const waiting = data ? waitingOf({ approvals: data[0], failedTasks: data[1], unread: data[2].items, dismissed }) : null;
  const dismissTask = (id: string) => {
    const next = [...dismissed.filter((x) => x !== id), id];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next.slice(-200)));
    } catch {
      // private mode: dismissed for this visit only
    }
  };
  return { waiting, error, reload, dismissTask };
}

/**
 * The Inbox: only what needs Dave, whichever business it is from. Actions to approve (decided
 * right here), things he asked for that didn't finish, and messages worth reading, each with what
 * to do about it and a way to clear it. Everything else that happened is in Activity; routine work
 * is summed up in the daily digest.
 */
export function Inbox({ api, feed }: { api: Api; feed: LiveFeed }) {
  const { waiting, error, reload, dismissTask } = useWaiting(api, feed);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const retry = async (task: Task) => {
    setBusy(task.id);
    setActionError(null);
    try {
      await api.retry(task.id);
      go(`task/${task.id}`);
    } catch (e) {
      setActionError(`Couldn't retry it: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const read = (ids: string[]) => Promise.all(ids.map((id) => api.markRead(id).catch(() => {}))).then(reload);
  const follow = async (n: StoredNotification, route: string) => {
    await api.markRead(n.id).catch(() => {});
    go(route);
  };

  return (
    <section className="inbox">
      <PageHead title="Inbox" sub="What needs you. Everything else that was done is in Activity." />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
      {!waiting && !error && <Skeleton rows={3} />}
      {waiting && waitingCount(waiting) === 0 && (
        <Empty icon="check">
          Nothing needs you. See <a href="#/activity">Activity</a> for what's been done, or ask for something in <a href="#/chat">Chat</a>.
        </Empty>
      )}

      {waiting && waiting.approvals.length > 0 && (
        <div className="inbox-group" data-help-pane="inbox.approvals">
          <h3>
            To approve <span className="count">{waiting.approvals.length}</span>
          </h3>
          {waiting.approvals.slice(0, MAX_APPROVALS).map((p) => (
            <ProposalCard key={p.id} api={api} proposal={p} />
          ))}
          {waiting.approvals.length > MAX_APPROVALS && (
            <p className="small">
              <a href="#/approvals">And {waiting.approvals.length - MAX_APPROVALS} more in Approvals</a>
            </p>
          )}
        </div>
      )}

      {waiting && waiting.failed.length > 0 && (
        <div className="inbox-group" data-help-pane="inbox.failed">
          <h3>
            Didn't finish <span className="count">{waiting.failed.length}</span>
          </h3>
          {waiting.failed.map((t) => (
            <article key={t.id} className="card inbox-card is-bad">
              <div className="row between small">
                <VTag id={t.vertical} />
                <span className="muted">{ago(t.updatedAt)}</span>
              </div>
              <p className="title">{askText(t.prompt).split("\n")[0]}</p>
              <p className="inbox-body">{(t.note ?? "The run failed.").replace(/^Run failed:\s*/, "")}</p>
              <div className="row wrap inbox-actions">
                <button type="button" className="primary small" disabled={busy === t.id} onClick={() => void retry(t)}>
                  <Icon name="refresh" size={14} /> {busy === t.id ? "Retrying…" : "Retry"}
                </button>
                <a className="button-link small" href={`#/task/${t.id}`}>
                  Open
                </a>
                <button type="button" className="ghost small" onClick={() => dismissTask(t.id)}>
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {waiting && waiting.messages.length > 0 && (
        <div className="inbox-group" data-help-pane="inbox.messages">
          <h3>
            For you <span className="count">{waiting.messages.length}</span>
            {waiting.messages.length > 1 && (
              <button type="button" className="link small" onClick={() => void read(waiting.messages.map((n) => n.id))}>
                Dismiss all
              </button>
            )}
          </h3>
          {waiting.messages.map((n) => (
            <article key={n.id} className="card inbox-card">
              <div className="row between small">
                <span>
                  <span className="tag">{KIND[n.category] ?? n.category}</span> {n.vertical && <VTag id={n.vertical} />}
                </span>
                <span className="muted">{ago(n.createdAt)}</span>
              </div>
              <p className="title">{n.title}</p>
              {n.body && <p className="inbox-body">{n.body}</p>}
              <NotificationMediaView media={n.media} title={n.title} />
              <div className="row wrap inbox-actions">
                {notificationLinks(n).map((l, i) => (
                  <button key={l.route} type="button" className={i === 0 ? "primary small" : "small"} onClick={() => void follow(n, l.route)}>
                    {l.label}
                  </button>
                ))}
                <button type="button" className="ghost small" onClick={() => void read([n.id])}>
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
