import type { Task } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago, usd } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { go } from "../router";

const FILTERS = ["", "queued", "running", "awaiting_approval", "deferred", "done", "failed"] as const;

export function Inbox({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [status, setStatus] = useState<string>("");
  const { data, error } = useLoad(() => api.tasks(status || undefined), feed, (m) => m.type === "task.updated", [status]);

  return (
    <section>
      <div className="row between">
        <h2>Inbox</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f ? f.replace("_", " ") : "all"}
            </option>
          ))}
        </select>
      </div>
      <Today api={api} feed={feed} onDeferred={() => setStatus("deferred")} />
      {error && <p className="error">{error}</p>}
      {data?.length === 0 && <p className="muted">Nothing here yet. Ask something in Chat.</p>}
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

  return (
    <div className="card today">
      <div className="row between small">
        <strong>Today</strong>
        <span className="muted">
          {usd(totals.costUsd)}
          {budget ? ` of ${usd(budget)}` : ""} spent
        </span>
      </div>
      <div className="row small wrap">
        <span>{totals.done} done</span>
        {totals.failed > 0 && <span className="status failed">{totals.failed} failed</span>}
        <span>{totals.autoActions} auto</span>
        <span className={totals.pendingApprovals ? "status awaiting_approval" : ""}>{totals.pendingApprovals} to approve</span>
      </div>
      {totals.deferred > 0 && (
        <p className="small status deferred note">
          {totals.deferred} task{totals.deferred > 1 ? "s" : ""} deferred by a daily budget. They run after midnight, or{" "}
          <a onClick={onDeferred}>retry one now</a>.
        </p>
      )}
      {active.length > 0 && (
        <ul className="list small">
          {active.map((d) => (
            <li key={d.vertical} className="row between">
              <span className="tag">{d.vertical}</span>
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
    <li className="item" onClick={() => go(`task/${task.id}`)}>
      <div className="row between">
        <span className="tag">{task.vertical}</span>
        <span className={`status ${task.status}`}>{task.status.replace("_", " ")}</span>
      </div>
      <div className="title">{task.prompt.split("\n")[0]}</div>
      <div className="muted small">
        {task.intent} · {task.route} · {ago(task.createdAt)}
      </div>
    </li>
  );
}
