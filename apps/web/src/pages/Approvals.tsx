import type { Proposal } from "@cc/core";
import { useState } from "react";
import type { Api } from "../api";
import { ago } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { go, routeQuery } from "../router";
import { SocialProposalBody, useSocialAccounts } from "../social";

export function Approvals({ api, feed, id }: { api: Api; feed: LiveFeed; id?: string }) {
  const { data, error } = useLoad(() => api.proposals("pending"), feed, (m) => m.type === "proposal.updated");
  // From a notification: #/approvals/<id> puts that proposal first; ?action= asks to confirm the button pressed.
  const focus = id ? data?.find((p) => p.id === id) : undefined;
  const action = routeQuery().get("action");
  const rest = data?.filter((p) => p !== focus);
  return (
    <section>
      <h2>Approvals</h2>
      {error && <p className="error">{error}</p>}
      {id && data && !focus && <p className="muted">That proposal is no longer waiting for approval.</p>}
      {focus && (action === "approve" || action === "reject") && <ConfirmAction api={api} proposal={focus} action={action} />}
      {focus && <ProposalCard api={api} proposal={focus} />}
      {data?.length === 0 && <p className="muted">Nothing waiting for you.</p>}
      {rest?.map((p) => (
        <ProposalCard key={p.id} api={api} proposal={p} />
      ))}
    </section>
  );
}

/**
 * The confirm step for Approve/Reject pressed on a push notification. The
 * service worker only opens the app here; the request is sent from the app
 * with its own credentials, after Dave confirms.
 */
function ConfirmAction({ api, proposal, action }: { api: Api; proposal: Proposal; action: "approve" | "reject" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    try {
      await (action === "approve" ? api.approve : api.reject)(proposal.id);
      go("approvals");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="card confirm" role="alertdialog" aria-label={`Confirm ${action}`}>
      <p className="title">
        {action === "approve" ? "Approve" : "Reject"} this {proposal.actionType} for {proposal.vertical}?
      </p>
      <p>{proposal.summary}</p>
      <div className="row">
        <button onClick={() => go(`approvals/${proposal.id}`)} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={confirm} disabled={busy}>
          Yes, {action}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function ProposalCard({ api, proposal }: { api: Api; proposal: Proposal }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const social = proposal.actionType.startsWith("social.");
  const socialAccounts = useSocialAccounts(api);
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
      {social && <SocialProposalBody proposal={proposal} accounts={socialAccounts} />}
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
