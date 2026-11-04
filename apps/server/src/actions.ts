import { randomUUID } from "node:crypto";
import type { Brain } from "@cc/brain";
import { type EventSource, type NewProposal, type NotificationCategory, type NotificationPriority, NewProposal as NewProposalSchema, type Policy, type Proposal, proposalPolicy } from "@cc/core";
import type { VerticalRegistry } from "@cc/verticals";
import type { Store } from "./db/store";
import type { Hub } from "./hub";
import type { Notifier } from "./push";

export interface ExecutorContext {
  brain: Brain;
  notifier: Notifier;
  /** The proposal's vertical, set when an executor runs. */
  vertical?: string;
}

export interface ActionExecutor {
  /** One-line description shown to agents in the propose tool. */
  description: string;
  /** Optional check when the action is proposed: throw to refuse it before it reaches Approvals. */
  validate?(payload: Record<string, unknown>, ctx: { vertical: string }): void | Promise<void>;
  execute(payload: Record<string, unknown>, ctx: ExecutorContext): Promise<unknown>;
}

const str = (payload: Record<string, unknown>, key: string): string => {
  const v = payload[key];
  if (typeof v !== "string" || !v) throw new Error(`payload.${key} must be a non-empty string`);
  return v;
};

/**
 * Executors for outward-facing actions. Phase 0 ships safe ones; email, Odoo
 * and social executors register here in later phases.
 */
export const builtinExecutors: Record<string, ActionExecutor> = {
  "brain.journal": {
    description: "Append a line to today's brain journal. payload: { text }",
    execute: async (payload, { brain }) => (await brain.appendJournal(str(payload, "text"))).path,
  },
  "brain.write": {
    description: "Create or replace a brain note. payload: { path, body, frontmatter? }",
    execute: async (payload, { brain }) => {
      const frontmatter = (payload.frontmatter ?? {}) as Record<string, unknown>;
      return (await brain.write(str(payload, "path"), { body: str(payload, "body"), frontmatter })).path;
    },
  },
  notify: {
    description:
      'Send a notification to Dave\'s devices. payload: { title, body, category?, priority?, url? }. category: "briefing" (morning brief, evening wrap), "reminder", "alert", "orders", "social" or "agent" (default). priority: "high", "normal" or "low".',
    execute: async (payload, { notifier, vertical }) => {
      // notifications: agents pick a category; never "approval"/"system", and never urgent (which breaks quiet hours).
      const category = AGENT_CATEGORIES.has(payload.category as string) ? (payload.category as NotificationCategory) : "agent";
      const asked = ["high", "normal", "low"].includes(payload.priority as string) ? (payload.priority as NotificationPriority) : undefined;
      await notifier.notify({
        title: str(payload, "title"),
        body: str(payload, "body"),
        category,
        priority: asked ?? (category === "alert" ? "high" : undefined),
        vertical,
        url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : undefined,
      });
      return "sent";
    },
  },
};

/** Categories an agent's `notify` may use. */
const AGENT_CATEGORIES: ReadonlySet<string> = new Set<NotificationCategory>(["briefing", "reminder", "alert", "orders", "social", "digest", "agent"]);

/** Event sources Dave controls. Anything else (email, webhook, ...) carries outside text. */
const TRUSTED_SOURCES: ReadonlySet<EventSource> = new Set(["chat", "cron", "system"]);

/** Internal-only actions that keep their policy even when outside input triggered the task. */
const UNTRUSTED_AUTO_ALLOWED: ReadonlySet<string> = new Set(["brain.journal", "brain.write"]);

/**
 * Proposals are the only way agents affect the outside world. Each one is
 * checked against its vertical's policy: `draft` waits for approval, the
 * `auto` levels execute straight away. A task triggered by untrusted input
 * (an email or webhook) auto-executes nothing but brain writes: its other
 * proposals are downgraded to `draft`, with the reason in `payload.policyDowngrade`.
 */
export class ActionService {
  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly verticals: VerticalRegistry,
    private readonly ctx: ExecutorContext,
    /** The executors, or a function giving the current ones (they change when the Accounts page reloads an integration). */
    private readonly executorSource: Record<string, ActionExecutor> | (() => Record<string, ActionExecutor>) = builtinExecutors,
  ) {}

  /**
   * Tasks whose runs read mail through the mail MCP server. Kept in memory: after a restart a
   * resumed run that reads mail again is marked again, and handoffs carry it (Pipeline.handoff).
   */
  private readonly readMail = new Map<string, string>();

  /** Marks a task as having read outside mail: its later proposals are drafts (see untrustedSource). */
  markReadMail(taskId: string): void {
    this.markOutsideInput(taskId, "email");
  }

  /** Marks a task as having read outside input of `source` (e.g. a transcript of an email task): its later proposals are drafts. */
  markOutsideInput(taskId: string, source: string): void {
    if (!this.readMail.has(taskId)) this.readMail.set(taskId, source);
  }

  /** The executors in use now: a proposal approved after a reload runs with the new credentials. */
  get executors(): Record<string, ActionExecutor> {
    return typeof this.executorSource === "function" ? this.executorSource() : this.executorSource;
  }

  /** `forceDraft` (a reason) holds this proposal for approval whatever the vertical's policy says. */
  async propose(input: NewProposal, options: { forceDraft?: string } = {}): Promise<Proposal> {
    const p = NewProposalSchema.parse(input);
    const vertical = this.verticals.require(p.vertical);
    await this.check(p.actionType, p.payload, vertical.id);
    const decided = await this.decide(p, options.forceDraft);
    const proposal = await this.store.insertProposal({ taskId: p.taskId ?? null, vertical: p.vertical, actionType: p.actionType, summary: p.summary, ...decided });
    this.hub.broadcast({ type: "proposal.updated", proposal });

    if (decided.policy === "draft") {
      await this.requestApproval(vertical.name, vertical.id, p.summary, proposal.id);
      return proposal;
    }
    return this.execute(proposal.id, ["pending"]);
  }

  /**
   * Proposes related actions as one batch (say, a message to each open delivery order), which
   * Dave approves or rejects once (`approveBatch`, `rejectBatch`) after seeing every item. Every
   * item is checked first, and a refused one stops the whole batch before anything is stored.
   * Each item gets its policy as if proposed alone (outside input still makes drafts); if any of
   * them needs approval, they all wait, so the batch is decided as a whole. Dave gets one
   * approval request for the batch, not one per item.
   */
  async proposeBatch(input: {
    taskId?: string | null;
    vertical: string;
    summary: string;
    items: { actionType: string; summary: string; payload?: Record<string, unknown> }[];
  }): Promise<{ batchId: string; proposals: Proposal[] }> {
    if (!input.summary.trim()) throw new Error("A batch needs a summary");
    if (input.items.length < 1 || input.items.length > MAX_BATCH) throw new Error(`A batch has 1 to ${MAX_BATCH} items, got ${input.items.length}`);
    const vertical = this.verticals.require(input.vertical);
    const items = input.items.map((item) => NewProposalSchema.parse({ ...item, taskId: input.taskId ?? null, vertical: vertical.id }));
    for (const [i, item] of items.entries()) {
      try {
        await this.check(item.actionType, item.payload, vertical.id);
      } catch (err) {
        throw new Error(`Item ${i + 1} (${item.actionType}): ${(err as Error).message}. Nothing in the batch was proposed.`);
      }
    }
    let decided = await Promise.all(items.map((item) => this.decide(item)));
    if (decided.some((d) => d.policy === "draft")) {
      const reason = "part of a batch that waits for Dave's approval as a whole";
      decided = decided.map((d) => (d.policy === "draft" ? d : { policy: "draft", payload: { ...d.payload, policyDowngrade: { from: d.policy, reason } } }));
    }
    const batchId = randomUUID();
    const stored = await this.store.transaction(async (tx) => {
      const out: Proposal[] = [];
      for (const [i, item] of items.entries()) {
        out.push(await tx.insertProposal({ taskId: item.taskId ?? null, vertical: vertical.id, actionType: item.actionType, summary: item.summary, batchId, batchSummary: input.summary.trim(), ...decided[i]! }));
      }
      return out;
    });
    for (const proposal of stored) this.hub.broadcast({ type: "proposal.updated", proposal });

    if (decided[0]!.policy === "draft") {
      const body = `${input.summary.trim()} (${plural(stored.length, "item")}). ${stored
        .slice(0, 3)
        .map((p) => p.summary)
        .join("; ")}${stored.length > 3 ? `; and ${stored.length - 3} more` : ""}`;
      await this.requestApproval(vertical.name, vertical.id, body, stored[0]!.id, { batchId, batchSize: stored.length, title: `Approve ${stored.length}: ${vertical.name}` });
      return { batchId, proposals: stored };
    }
    const done: Proposal[] = [];
    for (const proposal of stored) done.push(await this.execute(proposal.id, ["pending"]));
    return { batchId, proposals: done };
  }

  /** Refuses an unknown action type, or a payload its executor's `validate` rejects. */
  private async check(actionType: string, payload: Record<string, unknown>, vertical: string): Promise<void> {
    const executor = this.executors[actionType];
    if (!executor) {
      throw new Error(`Unknown action type "${actionType}". Known: ${Object.keys(this.executors).join(", ")}`);
    }
    await executor.validate?.(payload, { vertical });
  }

  /**
   * The policy a proposal gets: the vertical's (an internal Odoo note has its own, see
   * proposalPolicy), downgraded to `draft` with the reason in `payload.policyDowngrade` when
   * outside input triggered the task or the caller forces a draft.
   */
  private async decide(
    p: { taskId?: string | null; vertical: string; actionType: string; payload: Record<string, unknown> },
    forceDraft?: string,
  ): Promise<{ policy: Policy; payload: Record<string, unknown> }> {
    const vertical = this.verticals.require(p.vertical);
    let policy: Policy = proposalPolicy(vertical, p.actionType, p.payload);
    let payload = p.payload;
    const untrusted =
      policy !== "draft" && !UNTRUSTED_AUTO_ALLOWED.has(p.actionType) && !(await this.filesOwnEmail(p.taskId, p.actionType, payload))
        ? await this.untrustedSource(p.taskId)
        : null;
    if (untrusted) {
      payload = { ...payload, policyDowngrade: { from: policy, reason: `task was triggered by untrusted ${untrusted} input` } };
      policy = "draft";
    }
    if (forceDraft && policy !== "draft") {
      payload = { ...payload, policyDowngrade: { from: policy, reason: forceDraft } };
      policy = "draft";
    }
    return { policy, payload };
  }

  /** notifications: one "approvals" notification, replaced by each new request, with Approve/Reject buttons. */
  private async requestApproval(
    verticalName: string,
    verticalId: string,
    body: string,
    proposalId: string,
    batch?: { batchId: string; batchSize: number; title: string },
  ): Promise<void> {
    const pendingApprovals = (await this.store.listProposals({ status: "pending", limit: 200 })).length;
    await this.ctx.notifier.notify({
      title: batch?.title ?? `Approve: ${verticalName}`,
      body,
      url: `/approvals/${proposalId}`,
      category: "approval",
      priority: "high",
      vertical: verticalId,
      tag: "approvals",
      actions: [
        { action: "approve", title: batch ? "Review all" : "Approve" },
        { action: "reject", title: batch ? "Reject all" : "Reject" },
      ],
      data: { proposalId, pendingApprovals, ...(batch ? { batchId: batch.batchId, batchSize: batch.batchSize } : {}) },
    });
  }

  /**
   * The source of the event behind a task when it is not one Dave controls, else null.
   * Task-less proposals (admin MCP calls) are trusted; a task we can't trace back is not.
   */
  async untrustedSource(taskId: string | null | undefined): Promise<string | null> {
    if (!taskId) return null;
    // A run that looked mail up itself (the mail MCP server) has read outside input too.
    const read = this.readMail.get(taskId);
    if (read) return read;
    const task = await this.store.getTask(taskId);
    const event = task ? await this.store.getEvent(task.eventId) : null;
    if (!event) return "unknown";
    // A handoff between roles carries the trust of the event that started its chain (docs/ORG.md).
    if (event.source === "system" && event.kind === "handoff") {
      const origin = typeof event.payload.originSource === "string" ? event.payload.originSource : "unknown";
      return TRUSTED_SOURCES.has(origin as EventSource) ? null : origin;
    }
    return TRUSTED_SOURCES.has(event.source) ? null : event.source;
  }

  /**
   * True for `email.label` on the very email (same account and Message-ID) that
   * started the task: filing it only touches Dave's own mailbox and can't be
   * aimed at other mail, so it keeps its policy even though the email is outside
   * input. Labelling any other message from such a task waits for approval.
   */
  private async filesOwnEmail(taskId: string | null | undefined, actionType: string, payload: Record<string, unknown>): Promise<boolean> {
    if (actionType !== "email.label" || !taskId) return false;
    const task = await this.store.getTask(taskId);
    const event = task ? await this.store.getEvent(task.eventId) : null;
    if (event?.source !== "email") return false;
    const bare = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^<|>$/g, "") : "");
    return !!bare(event.payload.messageId) && bare(event.payload.messageId) === bare(payload.messageId) && event.payload.accountId === payload.accountId;
  }

  /** Approvals waiting on Dave, newest first; all verticals unless one is given. */
  async pending(vertical?: string): Promise<Proposal[]> {
    return this.store.listProposals({ status: "pending", vertical, limit: 100 });
  }

  async approve(id: string): Promise<Proposal> {
    return this.execute(id, ["pending"]);
  }

  /**
   * Dave's edit of a pending proposal before he approves it. The new payload is
   * validated like a fresh proposal; `policyDowngrade` (why it waits for approval)
   * is the server's and is kept whatever the edit says.
   */
  async edit(id: string, payload: Record<string, unknown>): Promise<Proposal> {
    const current = await this.store.getProposal(id);
    if (!current || current.status !== "pending") throw new ProposalStateError(id);
    const { policyDowngrade: _ignored, ...edited } = payload;
    const next = current.payload.policyDowngrade === undefined ? edited : { ...edited, policyDowngrade: current.payload.policyDowngrade };
    try {
      await this.executors[current.actionType]?.validate?.(next, { vertical: current.vertical });
    } catch (err) {
      throw new ProposalInvalidError((err as Error).message);
    }
    const proposal = await this.store.updateProposalPayload(id, next);
    if (!proposal) throw new ProposalStateError(id);
    this.hub.broadcast({ type: "proposal.updated", proposal });
    return proposal;
  }

  /**
   * Approves every item of a batch still pending, one after another; an item that fails to run
   * doesn't stop the others. Throws ProposalStateError when nothing in the batch is pending.
   */
  async approveBatch(batchId: string): Promise<Proposal[]> {
    const pending = oldestFirst(await this.store.listProposals({ batchId, status: "pending", limit: MAX_BATCH }));
    if (!pending.length) throw new ProposalStateError(`batch ${batchId}`);
    const out: Proposal[] = [];
    for (const p of pending) {
      try {
        out.push(await this.execute(p.id, ["pending"]));
      } catch (err) {
        // Decided meanwhile (say, left out from the Approvals page): skip it.
        if (!(err instanceof ProposalStateError)) throw err;
      }
    }
    return out;
  }

  /** Rejects every item of a batch still pending. Throws ProposalStateError when nothing is. */
  async rejectBatch(batchId: string): Promise<Proposal[]> {
    const pending = oldestFirst(await this.store.listProposals({ batchId, status: "pending", limit: MAX_BATCH }));
    if (!pending.length) throw new ProposalStateError(`batch ${batchId}`);
    const out: Proposal[] = [];
    for (const p of pending) {
      try {
        out.push(await this.reject(p.id));
      } catch (err) {
        if (!(err instanceof ProposalStateError)) throw err;
      }
    }
    return out;
  }

  async reject(id: string): Promise<Proposal> {
    const proposal = await this.store.transitionProposal(id, ["pending"], "rejected");
    if (!proposal) throw new ProposalStateError(id);
    this.hub.broadcast({ type: "proposal.updated", proposal });
    await this.settleTask(proposal);
    return proposal;
  }

  private async execute(id: string, from: Proposal["status"][]): Promise<Proposal> {
    const approved = await this.store.transitionProposal(id, from, "approved");
    if (!approved) throw new ProposalStateError(id);
    this.hub.broadcast({ type: "proposal.updated", proposal: approved });

    const executor = this.executors[approved.actionType];
    let final: Proposal | null;
    try {
      if (!executor) throw new Error(`No executor for ${approved.actionType}`);
      const result = await executor.execute(approved.payload, { ...this.ctx, vertical: approved.vertical });
      final = await this.store.transitionProposal(id, ["approved"], "executed", { ok: true, result: result ?? null });
    } catch (err) {
      final = await this.store.transitionProposal(id, ["approved"], "failed", { ok: false, error: (err as Error).message });
    }
    this.hub.broadcast({ type: "proposal.updated", proposal: final! });
    await this.settleTask(final!);
    return final!;
  }

  /** Called once a proposal is decided (notifications: marks its approval request read). */
  onDecided?: (proposal: Proposal) => Promise<void> | void;

  /** A task waiting on approvals is done once none of its proposals are pending. */
  private async settleTask(proposal: Proposal): Promise<void> {
    await Promise.resolve(this.onDecided?.(proposal)).catch((err) => console.error("[actions] onDecided", err));
    if (!proposal.taskId) return;
    const task = await this.store.getTask(proposal.taskId);
    if (task?.status !== "awaiting_approval") return;
    const pending = await this.store.listProposals({ taskId: task.id, status: "pending" });
    if (pending.length > 0) return;
    // Conditional: a reply may have re-queued the task since it was read.
    const done = await this.store.setTaskStatusIf(task.id, ["awaiting_approval"], "done");
    if (done) this.hub.broadcast({ type: "task.updated", task: done });
  }
}

/** Most items in one batch. */
export const MAX_BATCH = 100;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Oldest first; `proposals` come newest first from the database. */
function oldestFirst(proposals: Proposal[]): Proposal[] {
  return [...proposals].reverse().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** An edited payload its executor refuses. */
export class ProposalInvalidError extends Error {}

export class ProposalStateError extends Error {
  constructor(id: string) {
    super(`Proposal ${id} is not pending`);
  }
}
