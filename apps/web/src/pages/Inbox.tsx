import { isStopped, type Task } from "@cc/core";
import { useContext, useState } from "react";
import type { Api } from "../api";
import { ago, askText, usd } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLoad } from "../live";
import { go, useRouteQuery } from "../router";
import { Empty, ErrorBanner, PageHead, Skeleton, Status, TaskTag, VerticalsContext, VTag } from "../ui";

const FILTERS = ["", "queued", "running", "awaiting_approval", "deferred", "done", "failed"] as const;

export function Inbox({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [status, setStatus] = useState<string>("");
  // `#/inbox?vertical=` (the vertical filter) narrows the list to one vertical; `&role=` (from the Org page) to one role.
  const query = useRouteQuery();
  const vertical = query.get("vertical") || undefined;
  const role = query.get("role") || undefined;
  const verticals = Object.values(useContext(VerticalsContext)).sort((a, b) => a.name.localeCompare(b.name));
  // Choosing a vertical clears a role filter, which may belong to another vertical.
  const pickVertical = (id: string) => go(id ? `inbox?vertical=${encodeURIComponent(id)}` : "inbox");
  const { data, error } = useLoad(
    () => api.tasks(status || undefined, { vertical, role }),
    feed,
    (m) => m.type === "task.updated",
    [status, vertical, role],
  );

  return (
    <section>
      <PageHead
        title="Inbox"
        sub={
          role ? (
            <span className="filter-tag">
              Showing <VTag id={vertical ?? ""}>{`${vertical ? `${vertical} / ` : ""}${role}`}</VTag> <a href="#/inbox">show all</a>
            </span>
          ) : undefined
        }
      >
        <select className="inbox-filter" data-help-key="inbox.filter" value={vertical ?? ""} onChange={(e) => pickVertical(e.target.value)} aria-label="Filter by vertical">
          <option value="">all verticals</option>
          {verticals.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
          {/* A vertical in the link that the list doesn't know (yet): keep it selectable. */}
          {vertical && !verticals.some((v) => v.id === vertical) && <option value={vertical}>{vertical}</option>}
        </select>
        <select className="inbox-filter" data-help-key="inbox.filter" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f ? f.replace("_", " ") : "all statuses"}
            </option>
          ))}
        </select>
      </PageHead>
      {!status && !vertical && !role && <WaitingForYou api={api} feed={feed} />}
      <Today api={api} feed={feed} onDeferred={() => setStatus("deferred")} />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!data && !error && <Skeleton rows={4} />}
      {data?.length === 0 && (
        <Empty icon="inbox">
          Nothing here yet. Ask something in <a href="#/chat">Chat</a>.
        </Empty>
      )}
      <ul className="list">{data?.map((t) => <TaskRow key={t.id} task={t} />)}</ul>
    </section>
  );
}

/** How long a failed task stays under "Waiting for you". */
const FAILED_FOR_MS = 48 * 3_600_000;

/**
 * The top of the Inbox: what needs Dave now, whichever business it is from. Approvals to
 * decide, things he asked for that didn't finish, and what he's been told but hasn't read.
 * Each row opens the thing itself.
 */
function WaitingForYou({ api, feed }: { api: Api; feed: LiveFeed }) {
  const { data } = useLoad(
    () => Promise.all([api.proposals("pending"), api.tasks("failed"), api.notifications({ unread: true, limit: 20 })]),
    feed,
    (m) => m.type === "task.updated" || m.type === "proposal.updated" || m.type === "notifications.updated",
  );
  if (!data) return null;
  const [approvals, failedTasks, unread] = data;
  const failed = failedTasks.filter((t) => !isStopped(t) && Date.now() - Date.parse(t.updatedAt) < FAILED_FOR_MS);
  // Approval requests and failures are already above; a task's progress updates aren't news.
  const failedIds = new Set(failed.map((t) => t.id));
  const told = unread.items.filter((n) => n.category !== "approval" && !(typeof n.data?.taskId === "string" && failedIds.has(n.data.taskId)) && !(n.category === "agent" && n.tag?.startsWith("progress-") && !n.data?.outcome));
  const nothing = !approvals.length && !failed.length && !told.length;

  return (
    <div className="card waiting" data-help-pane="inbox.waiting">
      <h3>Waiting for you</h3>
      {nothing && <p className="muted small">Nothing. Approvals, anything that didn't finish and unread messages show here.</p>}
      {approvals.length > 0 && (
        <div className="waiting-group">
          <p className="small">
            {approvals.length} to approve · <a href="#/approvals">see all</a>
          </p>
          {approvals.slice(0, 3).map((p) => (
            <a key={p.id} className="waiting-row" href={`#/approvals/${p.id}`}>
              <p className="title">{p.summary}</p>
              <p className="sub">
                <VTag id={p.vertical} /> {ago(p.createdAt)}
              </p>
            </a>
          ))}
          {approvals.length > 3 && <p className="small muted">and {approvals.length - 3} more</p>}
        </div>
      )}
      {failed.length > 0 && (
        <div className="waiting-group">
          <p className="small">Didn't finish</p>
          {failed.slice(0, 3).map((t) => (
            <a key={t.id} className="waiting-row bad" href={`#/task/${t.id}`}>
              <p className="title">{askText(t.prompt).split("\n")[0]}</p>
              <p className="sub">{`${(t.note ?? "The run failed").replace(/^Run failed:\s*/, "").replace(/[.\s]+$/, "")}. Open it to retry or reply.`}</p>
            </a>
          ))}
          {failed.length > 3 && <p className="small muted">and {failed.length - 3} more</p>}
        </div>
      )}
      {told.length > 0 && (
        <div className="waiting-group">
          <p className="small">
            {told.length} unread · <a href="#/notifications">see all</a>
          </p>
          {told.slice(0, 3).map((n) => (
            <a key={n.id} className="waiting-row" href={`#/${(n.url ?? "/notifications").replace(/^\//, "")}${n.url ? `${n.url.includes("?") ? "&" : "?"}n=${n.id}` : ""}`}>
              <p className="title">{n.title}</p>
              {n.body && <p className="sub">{n.body}</p>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Today's digest numbers across verticals, with spend against the budgets. */
function Today({ api, feed, onDeferred }: { api: Api; feed: LiveFeed; onDeferred: () => void }) {
  const { data } = useLoad(
    () => Promise.all([api.digest(), api.stats()]),
    feed,
    (m) => m.type === "task.updated" || m.type === "proposal.updated",
  );
  if (!data) return null;
  const [{ totals, digests }, stats] = data;
  const active = digests.filter((d) => d.costUsd > 0 || Object.values(d.counts).some((n) => n > 0));
  const budget = stats.budgets.globalUsd;
  const share = budget ? Math.min(1, totals.costUsd / budget) : 0;

  return (
    <div className="card today" data-help-pane="inbox.digest">
      <div className="today-head">
        <strong>Today</strong>
        <span className="muted small">
          {usd(totals.costUsd)}
          {budget ? ` of ${usd(budget)}` : ""} spent
        </span>
      </div>
      {budget ? (
        <div className={`meter ${totals.costUsd >= budget ? "over" : ""}`} role="img" aria-label={`${Math.round(share * 100)}% of the daily budget`}>
          <span style={{ width: `${Math.max(2, share * 100)}%` }} />
        </div>
      ) : null}
      <div className="stats">
        <div className="stat">
          <span className="stat-n">{totals.done}</span>
          <span className="stat-l">done</span>
        </div>
        <div className={`stat ${totals.failed > 0 ? "bad" : ""}`}>
          <span className="stat-n">{totals.failed}</span>
          <span className="stat-l">failed</span>
        </div>
        <div className="stat">
          <span className="stat-n">{totals.autoActions}</span>
          <span className="stat-l">auto actions</span>
        </div>
        <a className={`stat ${totals.pendingApprovals ? "warn" : ""}`} href="#/approvals">
          <span className="stat-n">{totals.pendingApprovals}</span>
          <span className="stat-l">to approve</span>
        </a>
      </div>
      {totals.deferred > 0 && (
        <p className="small status deferred note">
          {totals.deferred} task{totals.deferred > 1 ? "s" : ""} deferred by a daily budget. They run after midnight, or{" "}
          <button type="button" className="link" onClick={onDeferred}>
            retry one now
          </button>
          .
        </p>
      )}
      {active.length > 0 && (
        <ul className="list small">
          {active.map((d) => (
            <li key={d.vertical} className="row between">
              <VTag id={d.vertical} />
              <span className="muted grow">
                {d.counts.done} done · {d.counts.pendingApprovals} to approve
              </span>
              <span className={d.budgetUsd && d.costUsd >= d.budgetUsd ? "status failed" : "muted"}>
                {usd(d.costUsd)}
                {d.budgetUsd ? ` / ${usd(d.budgetUsd)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskRow({ task }: { task: Task }) {
  return (
    <li className="item">
      <a className="item-link" href={`#/task/${task.id}`}>
        <div className="item-top">
          <TaskTag task={task} />
          <Status value={task.status} />
        </div>
        <div className="title">{askText(task.prompt).split("\n")[0]}</div>
        {/* How it came out, so the list can be read without opening each task. */}
        {task.status === "failed" && task.note && !isStopped(task) ? (
          <div className="outcome bad">{task.note}</div>
        ) : task.outcome && (task.status === "done" || task.status === "awaiting_approval") ? (
          <div className="outcome">{task.outcome}</div>
        ) : null}
        <div className="meta">
          {task.role && <span className="role">{task.role}</span>}
          <span>{task.intent}</span>
          <span>{task.route}</span>
          <span>
            <Icon name="clock" size={13} /> {ago(task.createdAt)}
          </span>
        </div>
      </a>
    </li>
  );
}
