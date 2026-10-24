import type { AgentMessage, Task } from "@cc/core";
import { type FormEvent, useEffect, useState } from "react";
import type { Api } from "../api";
import { type LiveFeed, useLive } from "../live";
import { go } from "../router";
import { Transcript } from "./Transcript";

type Turn = { text: string; task: Task; messages: AgentMessage[]; result?: string };

/** Talk to the command agent. Each message becomes a task; replies stream in live. */
export function Chat({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [verticals, setVerticals] = useState<{ id: string; name: string }[]>([]);
  const [vertical, setVertical] = useState("");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.verticals().then(setVerticals).catch(() => {});
  }, [api]);

  useLive(feed, (m) => {
    if (m.type === "run.message") {
      setTurns((ts) => ts.map((t) => (t.task.id === m.taskId ? { ...t, messages: [...t.messages, m.message] } : t)));
    }
    if (m.type === "task.updated") {
      setTurns((ts) => ts.map((t) => (t.task.id === m.task.id ? { ...t, task: m.task } : t)));
    }
  });

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    setError(null);
    try {
      const { task } = await api.chat(message, vertical || undefined);
      setTurns((ts) => [...ts, { text: message, task, messages: [] }]);
    } catch (err) {
      setError((err as Error).message);
      setText(message);
    }
  };

  return (
    <section className="chat">
      <div className="row between">
        <h2>Chat</h2>
        <a className="drive-link" href="#/drive" aria-label="Drive mode: talk hands-free">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"
            />
          </svg>
          <span>Drive mode</span>
        </a>
      </div>
      <div className="turns">
        {turns.length === 0 && <p className="muted">Ask the command agent anything. Start with a vertical name (e.g. "dms: …") or pick one below.</p>}
        {turns.map((t) => (
          <div key={t.task.id} className="turn">
            <div className="bubble me">{t.text}</div>
            <div className="bubble agent">
              <div className="row between small">
                <span className="tag">{t.task.vertical}</span>
                <a className={`status ${t.task.status}`} onClick={() => go(`task/${t.task.id}`)}>
                  {t.task.status.replace("_", " ")}
                </a>
              </div>
              <Transcript messages={t.messages} />
            </div>
          </div>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={send}>
        <select value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Vertical">
          <option value="">auto</option>
          {verticals.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What needs doing?"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button className="primary">Send</button>
      </form>
    </section>
  );
}
