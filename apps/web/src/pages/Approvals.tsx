import type { Proposal } from "@cc/core";
import { type FormEvent, useState } from "react";
import type { Api } from "../api";
import { ago } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLoad } from "../live";
import { go, routeQuery } from "../router";
import { SocialProposalBody, useSocialAccounts } from "../social";
import { Empty, ErrorBanner, PageHead, Skeleton, Status, VTag } from "../ui";
import { VideoPreview, videoOf } from "../video";
import { ErrorReport } from "../copy";

export function Approvals({ api, feed, id }: { api: Api; feed: LiveFeed; id?: string }) {
  const { data, error } = useLoad(() => api.proposals("pending"), feed, (m) => m.type === "proposal.updated");
  // A batch (propose_batch) is one card with all its items, decided once.
  const units = data ? approvalUnits(data) : undefined;
  // From a notification: #/approvals/<id> puts that proposal (or its batch) first; ?action= asks to confirm the button pressed.
  const focus = id ? units?.find((u) => u.some((p) => p.id === id)) : undefined;
  const action = routeQuery().get("action");
  const rest = units?.filter((u) => u !== focus);
  return (
    <section>
      <PageHead title="Approvals" sub={units?.length ? `${units.length} waiting for you` : undefined} />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!data && !error && <Skeleton rows={2} />}
      {data?.length === 0 && <Empty icon="approvals">Nothing waiting for you. Outward-facing actions that need a yes show up here.</Empty>}
      {id && data && !focus && <Empty icon="check">That proposal is no longer waiting for approval.</Empty>}
      {focus && (action === "approve" || action === "reject") && <ConfirmAction api={api} unit={focus} action={action} />}
      {focus && <UnitCard api={api} unit={focus} />}
      {rest?.map((u) => (
        <UnitCard key={u[0]!.batchId ?? u[0]!.id} api={api} unit={u} />
      ))}
    </section>
  );
}

/** Pending proposals, newest first, as cards: a batch's items together (oldest first), others alone. */
export function approvalUnits(proposals: Proposal[]): Proposal[][] {
  const units: Proposal[][] = [];
  const batches = new Map<string, Proposal[]>();
  for (const p of proposals) {
    if (!p.batchId) units.push([p]);
    else if (batches.has(p.batchId)) batches.get(p.batchId)!.unshift(p);
    else {
      const unit = [p];
      batches.set(p.batchId, unit);
      units.push(unit);
    }
  }
  return units;
}

function UnitCard({ api, unit }: { api: Api; unit: Proposal[] }) {
  return unit[0]!.batchId ? <BatchCard api={api} items={unit} /> : <ProposalCard api={api} proposal={unit[0]!} />;
}

/** Who an item goes to, from its payload: an address, an Odoo record, a social account. */
function recipientOf(p: Proposal): string | null {
  const v = p.payload;
  if (typeof v.to === "string" && v.to) return v.to;
  if (Array.isArray(v.to)) return v.to.join(", ");
  if (typeof v.model === "string" && typeof v.id === "number") return `${v.model} #${v.id}${v.internal === true ? " (internal note)" : ""}`;
  if (typeof v.accountId === "string") return v.accountId;
  return null;
}

/** The text an item sends, from its payload. */
function messageOf(p: Proposal): string | null {
  for (const k of ["body", "text", "message", "content"]) if (typeof p.payload[k] === "string" && p.payload[k]) return p.payload[k] as string;
  return null;
}

/**
 * A batch: every item with its recipient and message, then one Approve all / Reject all. An item
 * can be left out (rejected) first; the batch decision covers the items still waiting.
 */
function BatchCard({ api, items }: { api: Api; items: Proposal[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = items[0]!;
  const batchId = first.batchId!;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const kinds = [...new Set(items.map((p) => p.actionType))];
  return (
    <div className="card proposal batch is-pending" data-batch={batchId}>
      <div className="proposal-head small">
        <span className="row">
          <VTag id={first.vertical} /> {kinds.map((k) => <code key={k} className="action-type">{k}</code>)}
        </span>
        <span className="muted">batch of {items.length}</span>
      </div>
      <p className="title">{first.batchSummary ?? first.summary}</p>
      <ol className="batch-items">
        {items.map((p) => {
          const to = recipientOf(p);
          const text = messageOf(p);
          return (
            <li key={p.id} className="batch-item">
              <div className="row wrap">
                <strong>{p.summary}</strong>
                <button className="ghost small" disabled={busy || items.length === 1} title="Reject just this one" onClick={() => act(() => api.reject(p.id))}>
                  Leave out
                </button>
              </div>
              {to && <div className="small muted">To: {to}</div>}
              {text && <pre className="batch-message">{text}</pre>}
              <details>
                <summary className="muted small">Details</summary>
                <pre>{JSON.stringify(p.payload, null, 2)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="proposal-foot" data-help-key="approvals.decide">
        <span className="muted small">
          {ago(first.createdAt)}
          {first.taskId && (
            <>
              {" · "}
              <a href={`#/task/${first.taskId}`}>task</a>
            </>
          )}
        </span>
        <span className="actions">
          <button className="danger-text" disabled={busy} onClick={() => act(() => api.rejectBatch(batchId))}>
            <Icon name="x" size={16} />
            Reject all {items.length}
          </button>
          <button className="primary" disabled={busy} onClick={() => act(() => api.approveBatch(batchId))}>
            <Icon name="check" size={16} />
            Approve all {items.length}
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The confirm step for Approve/Reject pressed on a push notification. The
 * service worker only opens the app here; the request is sent from the app
 * with its own credentials, after Dave confirms.
 */
function ConfirmAction({ api, unit, action }: { api: Api; unit: Proposal[]; action: "approve" | "reject" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposal = unit[0]!;
  const batchId = proposal.batchId;
  const confirm = async () => {
    setBusy(true);
    try {
      if (batchId) await (action === "approve" ? api.approveBatch : api.rejectBatch)(batchId);
      else await (action === "approve" ? api.approve : api.reject)(proposal.id);
      go("approvals");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="card confirm" data-help-pane="approvals.confirm" role="alertdialog" aria-label={`Confirm ${action}`}>
      <p className="title">
        {batchId
          ? `${action === "approve" ? "Approve" : "Reject"} all ${unit.length} in this batch for ${proposal.vertical}?`
          : `${action === "approve" ? "Approve" : "Reject"} this ${proposal.actionType} for ${proposal.vertical}?`}
      </p>
      <p>{batchId ? `${proposal.batchSummary ?? proposal.summary}. Every item is listed below.` : proposal.summary}</p>
      <div className="button-row">
        <button onClick={() => go(`approvals/${proposal.id}`)} disabled={busy}>
          Cancel
        </button>
        <button className={action === "approve" ? "primary" : "danger"} onClick={confirm} disabled={busy}>
          Yes, {action}
          {batchId ? ` all ${unit.length}` : ""}
        </button>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </div>
  );
}

export function ProposalCard({ api, proposal }: { api: Api; proposal: Proposal }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Editing the payload, or writing feedback for the agent. */
  const [mode, setMode] = useState<"view" | "edit" | "changes">("view");
  const [sent, setSent] = useState(false);
  const social = proposal.actionType.startsWith("social.");
  /** A rendered video to watch before approving (video productions propose social.campaign with `video`). */
  const video = videoOf(proposal.payload);
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
    <div className={`card proposal ${proposal.status === "pending" ? "is-pending" : ""}`}>
      <div className="proposal-head small">
        <span className="row">
          <VTag id={proposal.vertical} /> <code className="action-type">{proposal.actionType}</code>
        </span>
        <Status value={proposal.status} />
      </div>
      <p className="title">{proposal.summary}</p>
      {video && <VideoPreview video={video} title={typeof proposal.payload.title === "string" ? proposal.payload.title : proposal.summary} />}
      {social && <SocialProposalBody proposal={proposal} accounts={socialAccounts} />}
      {proposal.status === "failed" && (
        <ErrorReport
          title={`${proposal.actionType} failed`}
          error={failureText(proposal.result)}
          facts={[
            ["Approval", proposal.id],
            ["Action", proposal.actionType],
            ["Summary", proposal.summary],
            ["Business", proposal.vertical],
            ["Task", proposal.taskId],
            ["Proposed", proposal.createdAt],
            ["Decided", proposal.decidedAt],
          ]}
        />
      )}
      <details>
        <summary className="muted small">Details</summary>
        <pre>{JSON.stringify(proposal.payload, null, 2)}</pre>
        {proposal.result != null && <pre>{JSON.stringify(proposal.result, null, 2)}</pre>}
      </details>
      {proposal.status === "pending" && mode === "view" && !sent && (
        <div className="proposal-tools row wrap">
          <button className="ghost" data-help-key="approvals.edit" disabled={busy} onClick={() => setMode("edit")}>
            <Icon name="edit" size={16} /> Edit
          </button>
          {proposal.taskId && (
            <button className="ghost" data-help-key="approvals.revise" disabled={busy} onClick={() => setMode("changes")}>
              <Icon name="chat" size={16} /> Ask for changes
            </button>
          )}
        </div>
      )}
      {mode === "edit" && (
        <PayloadEditor
          payload={proposal.payload}
          busy={busy}
          cancel={() => setMode("view")}
          save={(payload) =>
            act(async (id) => {
              await api.editProposal(id, payload);
              setMode("view");
            })
          }
        />
      )}
      {mode === "changes" && (
        <ChangesForm
          busy={busy}
          cancel={() => setMode("view")}
          send={(feedback) =>
            act(async (id) => {
              await api.reviseProposal(id, feedback);
              setMode("view");
              setSent(true);
            })
          }
        />
      )}
      {sent && <p className="small muted proposal-sent">Sent to the agent. It will propose a new version for you to approve.</p>}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="proposal-foot" data-help-key="approvals.decide">
        <span className="muted small">
          {ago(proposal.createdAt)}
          {proposal.taskId && (
            <>
              {" · "}
              <a href={`#/task/${proposal.taskId}`}>task</a>
            </>
          )}
        </span>
        {proposal.status === "pending" && mode === "view" && (
          <span className="actions">
            <button className="danger-text" disabled={busy} onClick={() => act(api.reject)}>
              <Icon name="x" size={16} />
              Reject
            </button>
            <button className="primary" disabled={busy} onClick={() => act(api.approve)}>
              <Icon name="check" size={16} />
              Approve
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

const HIDDEN_KEYS = new Set(["policyDowngrade"]);
/** Addressing first, the long text last, the rest in between (stored JSON comes back in no useful order). */
const FIRST = ["to", "cc", "bcc", "subject", "title", "name"];
const LAST = ["body", "text", "message", "html", "content"];
const fieldRank = (key: string) => (FIRST.includes(key) ? FIRST.indexOf(key) : LAST.includes(key) ? 100 + LAST.indexOf(key) : 50);
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Edits a proposal's payload: text fields as text boxes, numbers and yes/no as
 * such, anything structured (lists, nested objects) as JSON. Keys the server
 * owns (why it waits for approval) aren't shown and can't be changed.
 */
function PayloadEditor({ payload, busy, cancel, save }: { payload: Record<string, unknown>; busy: boolean; cancel: () => void; save: (p: Record<string, unknown>) => void }) {
  const keys = Object.keys(payload)
    .filter((k) => !HIDDEN_KEYS.has(k))
    .sort((a, b) => fieldRank(a) - fieldRank(b));
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      keys.map((k) => {
        const v = payload[k];
        return [k, typeof v === "string" ? v : typeof v === "boolean" ? v : typeof v === "number" ? String(v) : JSON.stringify(v, null, 2)];
      }),
    ),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, unknown> = {};
    for (const k of keys) {
      const original = payload[k];
      const v = values[k]!;
      if (typeof original === "string" || typeof original === "boolean") next[k] = v;
      else if (typeof original === "number") {
        const n = Number(v);
        if (!Number.isFinite(n)) return setError(`${label(k)} must be a number`);
        next[k] = n;
      } else {
        try {
          next[k] = JSON.parse(v as string);
        } catch {
          return setError(`${label(k)} isn't valid JSON`);
        }
      }
    }
    setError(null);
    save(next);
  };

  return (
    <form className="proposal-edit" data-help-pane="approvals.edit" onSubmit={submit}>
      {keys.length === 0 && <p className="muted small">This action has nothing to edit.</p>}
      {keys.map((k) => {
        const original = payload[k];
        const v = values[k]!;
        if (typeof original === "boolean") {
          return (
            <label key={k} className="row">
              <input type="checkbox" checked={v as boolean} onChange={(e) => setValues({ ...values, [k]: e.target.checked })} /> {label(k)}
            </label>
          );
        }
        const text = v as string;
        const structured = typeof original !== "string" && typeof original !== "number";
        const long = structured || text.length > 60 || text.includes("\n");
        return (
          <label key={k} className="field">
            <span>
              {label(k)}
              {structured && <span className="muted small"> (JSON)</span>}
            </span>
            {long ? (
              <textarea
                value={text}
                rows={Math.min(14, Math.max(3, text.split("\n").length + Math.floor(text.length / 70)))}
                className={structured ? "mono" : undefined}
                onChange={(e) => setValues({ ...values, [k]: e.target.value })}
              />
            ) : (
              <input type={typeof original === "number" ? "number" : "text"} value={text} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
            )}
          </label>
        );
      })}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="row wrap">
        <button type="submit" className="primary" disabled={busy}>
          Save changes
        </button>
        <button type="button" className="ghost" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** "Ask for changes": feedback that goes back to the agent, which proposes again. */
function ChangesForm({ busy, cancel, send }: { busy: boolean; cancel: () => void; send: (feedback: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="proposal-edit"
      data-help-pane="approvals.revise"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) send(text.trim());
      }}
    >
      <label className="field">
        <span>What should the agent change?</span>
        <textarea value={text} rows={3} autoFocus placeholder="e.g. Mention the restock date, and keep it shorter" onChange={(e) => setText(e.target.value)} />
        <span className="muted small">This proposal is rejected and your note goes to the agent, which proposes a new version.</span>
      </label>
      <div className="row wrap">
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          Send to agent
        </button>
        <button type="button" className="ghost" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The error an executor left in a failed proposal's result ({ ok: false, error }), or the result itself. */
function failureText(result: unknown): string {
  if (result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string") return (result as { error: string }).error;
  return result == null ? "It failed without a message." : JSON.stringify(result, null, 2);
}
