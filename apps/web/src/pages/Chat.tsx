import type { AgentMessage, Proposal, Task } from "@cc/core";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../api";
import { type LiveFeed, useLive } from "../live";
import { Icon } from "../icons";
import { Empty, ErrorBanner, PageHead, VTag } from "../ui";
import { ProposalCard } from "./Approvals";
import { Transcript } from "./Transcript";

type Turn = { key: number; text: string; task: Task; messages: AgentMessage[]; result?: string };

/** A task in these states has answered, so a follow-up can continue it. */
const REPLYABLE: Task["status"][] = ["done", "awaiting_approval", "failed"];

/** Applies `f` to the latest turn on `taskId` (a task's follow-ups each have their own turn). */
function onLatest(ts: Turn[], taskId: string, f: (t: Turn) => Turn): Turn[] {
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i]!.task.id === taskId) return ts.map((t, j) => (j === i ? f(t) : t));
  return ts;
}

type Chain = { taskIds: string[]; proposals: Proposal[] };

/**
 * The approvals of a chat thread, wherever the work went: the task's own and those of every role
 * it handed off to. Kept live: an update to a known proposal patches it in place, and anything
 * new in the chain (a handoff starting, a proposal from a role we haven't seen yet) refetches.
 */
function useChainProposals(api: Api, feed: LiveFeed, taskIds: string[]) {
  const [chains, setChains] = useState<Record<string, Chain>>({});
  const known = useRef(chains);
  known.current = chains;
  const ids = taskIds.join(",");

  const refresh = useCallback(
    (only?: string[]) => {
      for (const id of only ?? taskIds) {
        api
          .chainProposals(id)
          .then((chain) => setChains((cs) => ({ ...cs, [id]: chain })))
          .catch(() => {});
      }
    },
    [api, ids],
  );
  useEffect(() => refresh(), [refresh]);

  useLive(feed, (m) => {
    if (m.type === "proposal.updated") {
      const p = m.proposal;
      const owners = Object.entries(known.current).filter(([, c]) => p.taskId && c.taskIds.includes(p.taskId));
      if (!owners.length) return refresh(); // maybe from a role a thread just handed work to
      setChains((cs) => {
        const next = { ...cs };
        for (const [id, c] of owners) {
          const has = c.proposals.some((x) => x.id === p.id);
          next[id] = { ...c, proposals: has ? c.proposals.map((x) => (x.id === p.id ? p : x)) : [...c.proposals, p] };
        }
        return next;
      });
    }
    if (m.type === "task.updated" && !Object.values(known.current).some((c) => c.taskIds.includes(m.task.id))) {
      refresh(); // a new handoff task joins a chain
    }
  });
  return chains;
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

  // Proposals show inline on the latest turn of each task (follow-ups continue the same task).
  const latestTurnOf = new Map(turns.map((t) => [t.task.id, t.key]));
  const chains = useChainProposals(api, feed, [...latestTurnOf.keys()]);

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
      <PageHead
        title="Chat"
        sub="You're talking to the Chief of Staff, who hands work to the right role and tells you the outcome here. Follow-ups continue the chat until you start a new one."
      >
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
            Ask anything: the Chief of Staff answers, or passes it to the right role and reports back here. To go straight to a
            business, start with its name ("dms: …") or pick it below.
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
              {latestTurnOf.get(t.task.id) === t.key && <InlineProposals api={api} proposals={chains[t.task.id]?.proposals ?? []} />}
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
          aria-label="Send to"
        >
          <option value="">Chief of Staff</option>
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

/** Approvals in the chat thread: the pending ones in full, the decided ones folded away. */
function InlineProposals({ api, proposals }: { api: Api; proposals: Proposal[] }) {
  if (!proposals.length) return null;
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");
  return (
    <div className="inline-proposals">
      {pending.length > 0 && (
        <p className="small muted">
          {pending.length === 1 ? "Waiting for your approval:" : `${pending.length} waiting for your approval:`}
        </p>
      )}
      {pending.map((p) => (
        <ProposalCard key={p.id} api={api} proposal={p} />
      ))}
      {decided.length > 0 && (
        <details>
          <summary className="small muted">
            {decided.length} action{decided.length === 1 ? "" : "s"} done or decided
          </summary>
          {decided.map((p) => (
            <ProposalCard key={p.id} api={api} proposal={p} />
          ))}
        </details>
      )}
    </div>
  );
}
