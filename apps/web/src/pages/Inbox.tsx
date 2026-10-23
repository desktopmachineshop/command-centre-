import type { Task } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { go } from "../router";

const FILTERS = ["", "queued", "running", "awaiting_approval", "done", "failed"] as const;

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
      {error && <p className="error">{error}</p>}
      {data?.length === 0 && <p className="muted">Nothing here yet. Ask something in Chat.</p>}
      <ul className="list">{data?.map((t) => <TaskRow key={t.id} task={t} />)}</ul>
    </section>
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
