import type { AgentMessage, Task } from "@cc/core";
import { type FormEvent, useEffect, useState } from "react";
import type { Api } from "../api";
import { type LiveFeed, useLive } from "../live";
import { Icon } from "../icons";
import { Empty, ErrorBanner, PageHead, VTag } from "../ui";
import { Transcript } from "./Transcript";

type Turn = { key: number; text: string; task: Task; messages: AgentMessage[]; result?: string };

/** A task in these states has answered, so a follow-up can continue it. */
const REPLYABLE: Task["status"][] = ["done", "awaiting_approval", "failed"];

/** Applies `f` to the latest turn on `taskId` (a task's follow-ups each have their own turn). */
function onLatest(ts: Turn[], taskId: string, f: (t: Turn) => Turn): Turn[] {
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i]!.task.id === taskId) return ts.map((t, j) => (j === i ? f(t) : t));
  return ts;
}

/**
 * Talk to the command agent. The first message becomes a task; follow-ups
 * continue it (the agent resumes its session) until "New chat". Replies stream in live.
 */
export function Chat({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [verticals, setVerticals] = useState<{ id: string; name: string }[]>([]);
  const [vertical, setVertical] = useState("");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The task follow-ups continue; null starts a new one. */
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    api.verticals().then(setVerticals).catch(() => {});
  }, [api]);

  useLive(feed, (m) => {
    if (m.type === "run.message") {
      setTurns((ts) => onLatest(ts, m.taskId, (t) => ({ ...t, messages: [...t.messages, m.message] })));
    }
    if (m.type === "task.updated") {
      setTurns((ts) => onLatest(ts, m.task.id, (t) => ({ ...t, task: m.task })));
    }
  });

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    const thread = threadId ? turns.findLast((t) => t.task.id === threadId)?.task : undefined;
    if (thread && !REPLYABLE.includes(thread.status)) {
      setError("Still working on the last message: wait for its answer, or start a new chat.");
      return;
    }
    setText("");
    setError(null);
    try {
      const task = threadId ? await api.replyToTask(threadId, message, false) : (await api.chat(message, vertical || undefined)).task;
      setThreadId(task.id);
      setTurns((ts) => [...ts, { key: ts.length, text: message, task, messages: [] }]);
    } catch (err) {
      setError((err as Error).message);
      setText(message);
    }
  };

  return (
    <section className="chat">
      <PageHead title="Chat" sub="A message starts a task for the command agent; follow-ups continue it until you start a new chat.">
        {threadId && (
          <button type="button" onClick={() => setThreadId(null)}>
            New chat
          </button>
        )}
        <a className="drive-link" href="#/drive" aria-label="Drive mode: talk hands-free">
          <Icon name="drive" size={20} />
          <span>Drive mode</span>
        </a>
      </PageHead>
      <div className="turns">
        {turns.length === 0 && (
          <Empty icon="chat">
            Ask the command agent anything. Start with a vertical name (e.g. "dms: …") or pick one below.
          </Empty>
        )}
        {turns.map((t) => (
          <div key={t.key} className="turn">
            <div className="bubble me">{t.text}</div>
            <div className="bubble agent">
              <div className="row between small">
                <VTag id={t.task.vertical} />
                <a className={`status ${t.task.status}`} href={`#/task/${t.task.id}`} title="Open the task">
                  {t.task.status.replace("_", " ")}
                </a>
              </div>
              <Transcript messages={t.messages} />
            </div>
          </div>
        ))}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <form className="composer" onSubmit={send}>
        <select
          value={vertical}
          onChange={(e) => {
            setVertical(e.target.value);
            setThreadId(null);
          }}
          aria-label="Vertical"
        >
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
        <button className="primary" aria-label="Send">
          <Icon name="send" size={16} />
          Send
        </button>
      </form>
    </section>
  );
}
