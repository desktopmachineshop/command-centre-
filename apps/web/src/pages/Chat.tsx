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
      <h2>Chat</h2>
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
