import type { Proposal } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { go } from "../router";

export function Approvals({ api, feed }: { api: Api; feed: LiveFeed }) {
  const { data, error } = useLoad(() => api.proposals("pending"), feed, (m) => m.type === "proposal.updated");
  return (
    <section>
      <h2>Approvals</h2>
      {error && <p className="error">{error}</p>}
      {data?.length === 0 && <p className="muted">Nothing waiting for you.</p>}
      {data?.map((p) => (
        <ProposalCard key={p.id} api={api} proposal={p} />
      ))}
    </section>
  );
}

export function ProposalCard({ api, proposal }: { api: Api; proposal: Proposal }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: (id: string) => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn(proposal.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card proposal">
      <div className="row between small">
        <span>
          <span className="tag">{proposal.vertical}</span> <code>{proposal.actionType}</code>
        </span>
        <span className={`status ${proposal.status}`}>{proposal.status}</span>
      </div>
      <p className="title">{proposal.summary}</p>
      <details>
        <summary className="muted small">Details</summary>
        <pre>{JSON.stringify(proposal.payload, null, 2)}</pre>
        {proposal.result != null && <pre>{JSON.stringify(proposal.result, null, 2)}</pre>}
      </details>
      <div className="row between">
        <span className="muted small">
          {ago(proposal.createdAt)}
          {proposal.taskId && (
            <>
              {" · "}
              <a onClick={() => go(`task/${proposal.taskId}`)}>task</a>
            </>
          )}
        </span>
        {proposal.status === "pending" && (
          <span className="row">
            <button disabled={busy} onClick={() => act(api.reject)}>
              Reject
            </button>
            <button className="primary" disabled={busy} onClick={() => act(api.approve)}>
              Approve
            </button>
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
