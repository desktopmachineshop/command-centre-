import type { Brain } from "@cc/brain";
import { type EventSource, type NewProposal, type NotificationCategory, type NotificationPriority, NewProposal as NewProposalSchema, type Policy, policyFor, type Proposal } from "@cc/core";
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

  /** The executors in use now: a proposal approved after a reload runs with the new credentials. */
  get executors(): Record<string, ActionExecutor> {
    return typeof this.executorSource === "function" ? this.executorSource() : this.executorSource;
  }

  /** `forceDraft` (a reason) holds this proposal for approval whatever the vertical's policy says. */
  async propose(input: NewProposal, options: { forceDraft?: string } = {}): Promise<Proposal> {
    const p = NewProposalSchema.parse(input);
    const executor = this.executors[p.actionType];
    if (!executor) {
      throw new Error(`Unknown action type "${p.actionType}". Known: ${Object.keys(this.executors).join(", ")}`);
    }
    const vertical = this.verticals.require(p.vertical);
    await executor.validate?.(p.payload, { vertical: vertical.id });
    let policy: Policy = policyFor(vertical, p.actionType);
    let payload = p.payload;
    const untrusted = policy !== "draft" && !UNTRUSTED_AUTO_ALLOWED.has(p.actionType) ? await this.untrustedSource(p.taskId) : null;
    if (untrusted) {
      payload = { ...payload, policyDowngrade: { from: policy, reason: `task was triggered by untrusted ${untrusted} input` } };
      policy = "draft";
    }
    if (options.forceDraft && policy !== "draft") {
      payload = { ...payload, policyDowngrade: { from: policy, reason: options.forceDraft } };
      policy = "draft";
    }
    const proposal = await this.store.insertProposal({
      taskId: p.taskId ?? null,
      vertical: p.vertical,
      actionType: p.actionType,
      summary: p.summary,
      payload,
      policy,
    });
    this.hub.broadcast({ type: "proposal.updated", proposal });

    if (policy === "draft") {
      // notifications: one "approvals" notification, replaced by each new request, with Approve/Reject buttons.
      const pendingApprovals = (await this.store.listProposals({ status: "pending", limit: 200 })).length;
      await this.ctx.notifier.notify({
        title: `Approve: ${vertical.name}`,
        body: p.summary,
        url: `/approvals/${proposal.id}`,
        category: "approval",
        priority: "high",
        vertical: vertical.id,
        tag: "approvals",
        actions: [
          { action: "approve", title: "Approve" },
          { action: "reject", title: "Reject" },
        ],
        data: { proposalId: proposal.id, pendingApprovals },
      });
      return proposal;
    }
    return this.execute(proposal.id, ["pending"]);
  }

  /**
   * The source of the event behind a task when it is not one Dave controls, else null.
   * Task-less proposals (admin MCP calls) are trusted; a task we can't trace back is not.
   */
  async untrustedSource(taskId: string | null | undefined): Promise<string | null> {
    if (!taskId) return null;
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

/** An edited payload its executor refuses. */
export class ProposalInvalidError extends Error {}

export class ProposalStateError extends Error {
  constructor(id: string) {
    super(`Proposal ${id} is not pending`);
  }
}
