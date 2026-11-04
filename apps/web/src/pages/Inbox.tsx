import type { Task } from "@cc/core";
import { useContext, useState } from "react";
import type { Api } from "../api";
import { ago, askText, usd } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLoad } from "../live";
import { go, useRouteQuery } from "../router";
import { Empty, ErrorBanner, PageHead, Skeleton, Status, VerticalsContext, VTag } from "../ui";

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
          <VTag id={task.vertical} />
          <Status value={task.status} />
        </div>
        <div className="title">{askText(task.prompt).split("\n")[0]}</div>
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
