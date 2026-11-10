import { randomUUID } from "node:crypto";
import { type Brain, isMisplacedIssue } from "@cc/brain";
import {
  type EventSource,
  type NewProposal,
  type NotificationCategory,
  type NotificationMedia,
  type NotificationPriority,
  NewProposal as NewProposalSchema,
  type Policy,
  type Proposal,
  proposalPolicy,
} from "@cc/core";
import type { VerticalRegistry } from "@cc/verticals";
import type { Store } from "./db/store";
import type { Hub } from "./hub";
import { mediaKind } from "./http/social";
import type { Notifier } from "./push";

export interface ExecutorContext {
  brain: Brain;
  notifier: Notifier;
  /** The proposal's vertical, set when an executor runs. */
  vertical?: string;
  /** PUBLIC_BASE_URL: this server's own /media files are the only media an agent's notify may show. */
  publicBaseUrl?: string;
}

export interface ActionExecutor {
  /** One-line description shown to agents in the propose tool. */
  description: string;
  /** Optional check when the action is proposed: throw to refuse it before it reaches Approvals. */
  validate?(payload: Record<string, unknown>, ctx: { vertical: string; publicBaseUrl?: string }): void | Promise<void>;
  /**
   * Optional step when the action is proposed (and again when Dave edits it), after `validate`:
   * returns the payload to store (e.g. with facts looked up for the approval) and a note added to
   * the summary, so the approval request and the Approvals page both show it.
   */
  prepare?(payload: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; note?: string }>;
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
    validate: (payload) => {
      // Issues have one home (the brain's issues/ log, written with the brain tool report_issue).
      const path = str(payload, "path").replace(/^\/+/, "");
      if (!path.startsWith("issues/") && isMisplacedIssue({ path, frontmatter: (payload.frontmatter ?? {}) as Record<string, unknown> })) {
        throw new Error(`Issues go in the brain's central issue log, not ${path}: use the brain tool report_issue`);
      }
    },
    execute: async (payload, { brain }) => {
      const frontmatter = (payload.frontmatter ?? {}) as Record<string, unknown>;
      return (await brain.write(str(payload, "path"), { body: str(payload, "body"), frontmatter })).path;
    },
  },
  notify: {
    description:
      'Send a notification to Dave\'s devices. payload: { title, body, category?, priority?, url?, media? }. category: "briefing" (morning brief, evening wrap), "reminder", "alert", "orders", "social" or "agent" (default). priority: "high", "normal" or "low". media: up to 4 images or videos to show with it, each this server\'s own /media URL (as POST /api/media or the storage list returns it) or { url, alt? }; the app plays a video in place.',
    validate: (payload, { publicBaseUrl }) => {
      agentMedia(payload.media, publicBaseUrl);
    },
    execute: async (payload, { notifier, vertical, publicBaseUrl }) => {
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
        media: agentMedia(payload.media, publicBaseUrl),
      });
      return "sent";
    },
  },
};

/**
 * The media an agent's `notify` asked for. Only this server's own /media files are allowed
 * (`/media/<id>` or `<PUBLIC_BASE_URL>/media/<id>`), so outside input that reaches an agent can't
 * make the app load someone else's URL. Throws a readable error for anything else.
 */
export function agentMedia(raw: unknown, publicBaseUrl: string | undefined): NotificationMedia[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  if (!items.length) return [];
  if (items.length > 4) throw new Error("payload.media: at most 4 items");
  if (!publicBaseUrl) throw new Error("payload.media needs PUBLIC_BASE_URL set on the server (it is how the app and pushes load /media files)");
  const base = publicBaseUrl.replace(/\/+$/, "");
  return items.map((item, i) => {
    const entry = typeof item === "string" ? { url: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    const path = url.startsWith(`${base}/media/`) ? url.slice(base.length) : url;
    const id = path.startsWith("/media/") ? path.slice("/media/".length) : "";
    const type = mediaKind(id);
    if (!type) throw new Error(`payload.media[${i}]: must be an image or video from this server's /media (${base}/media/<id>), got ${JSON.stringify(url.slice(0, 200))}`);
    const alt = typeof entry.alt === "string" && entry.alt ? { alt: entry.alt.slice(0, 300) } : {};
    return { url: `${base}/media/${id}`, type, ...alt };
  });
}

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
    const p = await this.prepare(NewProposalSchema.parse(input));
    const vertical = this.verticals.require(p.vertical);
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
    const parsed = input.items.map((item) => NewProposalSchema.parse({ ...item, taskId: input.taskId ?? null, vertical: vertical.id }));
    const items: typeof parsed = [];
    for (const [i, item] of parsed.entries()) {
      try {
        items.push(await this.prepare(item));
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

  /** Checks a new proposal (`check`), then runs its executor's `prepare`: the payload and summary to store. */
  private async prepare<P extends { vertical: string; actionType: string; summary: string; payload: Record<string, unknown> }>(p: P): Promise<P> {
    await this.check(p.actionType, p.payload, p.vertical);
    const prepared = await this.executors[p.actionType]?.prepare?.(p.payload);
    if (!prepared) return p;
    return { ...p, payload: prepared.payload, summary: prepared.note ? `${p.summary.trim()} ${prepared.note}` : p.summary };
  }

  /** Refuses an unknown action type, or a payload its executor's `validate` rejects. */
  private async check(actionType: string, payload: Record<string, unknown>, vertical: string): Promise<void> {
    const executor = this.executors[actionType];
    if (!executor) {
      throw new Error(`Unknown action type "${actionType}". Known: ${Object.keys(this.executors).join(", ")}`);
    }
    await executor.validate?.(payload, { vertical, publicBaseUrl: this.ctx.publicBaseUrl });
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
    // A run that looked mail up itself (the mail MCP server), or read Reddit or a web page through
    // the reddit and research servers, has read outside input too.
    const read = this.readMail.get(taskId);
    if (read) return read;
    return this.originSource(taskId);
  }

  /**
   * Like `untrustedSource`, but only what started the task (or its handoff chain), ignoring what
   * its runs have read since: null for work Dave started. The research server asks this before
   * fetching a page, so a task that began with an email can't be talked into fetching a URL,
   * while a research task Dave asked for can read page after page.
   */
  async originSource(taskId: string | null | undefined): Promise<string | null> {
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
    let next = current.payload.policyDowngrade === undefined ? edited : { ...edited, policyDowngrade: current.payload.policyDowngrade };
    const executor = this.executors[current.actionType];
    let summary: string | undefined;
    try {
      await executor?.validate?.(next, { vertical: current.vertical, publicBaseUrl: this.ctx.publicBaseUrl });
      // Facts looked up for the approval (prepare) follow the edited payload, not the old one,
      // and so does their note at the end of the summary (e.g. a quote's new total).
      if (executor?.prepare) {
        const prepared = await executor.prepare(next);
        next = prepared.payload;
        if (prepared.note) summary = `${current.summary.replace(/\s*\[[^[\]]*\]$/, "").trim()} ${prepared.note}`;
      }
    } catch (err) {
      throw new ProposalInvalidError((err as Error).message);
    }
    const proposal = await this.store.updateProposalPayload(id, next, summary);
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

  /**
   * Cancels proposals that `replacement` is a revised version of (Dave asked for a change and the
   * agent proposed it again): each is marked rejected with `result.replacedBy`, so only the new one
   * waits for approval. Only pending proposals of the same task are replaced; others are skipped
   * and named in `skipped`.
   */
  async supersede(ids: readonly string[], replacement: Pick<Proposal, "id" | "taskId">): Promise<{ replaced: Proposal[]; skipped: string[] }> {
    const replaced: Proposal[] = [];
    const skipped: string[] = [];
    for (const id of new Set(ids)) {
      const old = id === replacement.id ? null : await this.store.getProposal(id).catch(() => null);
      if (!old || old.status !== "pending" || !old.taskId || old.taskId !== replacement.taskId) {
        skipped.push(id);
        continue;
      }
      const proposal = await this.store.transitionProposal(id, ["pending"], "rejected", { ok: false, replacedBy: replacement.id, error: "Replaced by a revised proposal" });
      if (!proposal) {
        skipped.push(id);
        continue;
      }
      this.hub.broadcast({ type: "proposal.updated", proposal });
      await this.settleTask(proposal);
      replaced.push(proposal);
    }
    return { replaced, skipped };
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
