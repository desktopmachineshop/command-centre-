import type { AdapterMap } from "./accounts";
import { platformLabel } from "./prompt";
import type { AdapterContext, AdapterLogger, PlatformAdapter, PublishResult, SocialAccount } from "./types";

/**
 * Pacing: a per-account minimum gap between submissions (posts, replies, DMs) and a cap per
 * rolling 24 hours, checked when an approved action is about to go out. It exists for accounts
 * that post as a person rather than through an API app (Reddit session mode), where a burst of
 * approved replies would look like, and be, a bot. It only ever slows things down:
 * - `social.reply`, `social.post` and `social.dm` that can't go yet are queued in the outbox for
 *   the next free slot, and the every-minute job sends them (`sendDueSubmissions`);
 * - campaign and scheduled posts are refused with the time they could go.
 * The limits come from the adapter (`pacing`) with `account.options.minGapMinutes` and
 * `account.options.dailyCap` over them; an account with neither is not paced.
 */

export interface PacingLimits {
  minGapMs: number;
  dailyCap: number;
}

const DAY_MS = 86_400_000;

/** The limits for an account, or null when it isn't paced. Options can loosen or tighten the adapter's defaults. */
export function pacingFor(account: SocialAccount, adapter: PlatformAdapter | undefined): PacingLimits | null {
  const base = adapter?.pacing?.(account) ?? null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const gap = num(account.options.minGapMinutes);
  const cap = num(account.options.dailyCap);
  if (!base && gap === undefined && cap === undefined) return null;
  return {
    minGapMs: Math.max(0, gap ?? base?.minGapMinutes ?? 0) * 60_000,
    dailyCap: Math.max(1, Math.floor(cap ?? base?.dailyCap ?? Number.MAX_SAFE_INTEGER)),
  };
}

/**
 * The earliest time at or after `now` at which one more submission keeps to the limits, given
 * when the account's earlier ones went (or are queued to go).
 */
export function nextSlot(times: Date[], now: Date, limits: PacingLimits): Date {
  const sorted = times.map((t) => t.getTime()).sort((a, b) => a - b);
  const latest = sorted.at(-1);
  let slot = Math.max(now.getTime(), latest === undefined ? 0 : latest + limits.minGapMs);
  for (let i = 0; i < 100; i++) {
    const window = sorted.filter((t) => t > slot - DAY_MS && t <= slot);
    if (window.length < limits.dailyCap) break;
    // Full day: the slot opens when the oldest of the last `dailyCap` falls out of the window.
    slot = window[window.length - limits.dailyCap]! + DAY_MS;
  }
  return new Date(slot);
}

export type PacedActionType = "social.post" | "social.reply" | "social.dm";

export interface OutboxEntry {
  id: string;
  accountId: string;
  vertical: string;
  actionType: PacedActionType;
  /** The approved action's payload, sent as it is when the slot comes. */
  payload: Record<string, unknown>;
  notBefore: string;
  status: "queued" | "sending" | "sent" | "failed" | "cancelled";
  result: unknown;
  createdAt: string;
}

/** Where submissions are recorded and queued. The server's Store implements this (`social_outbox`). */
export interface SubmissionStore {
  /** When this account's submissions since `since` went out, and when its queued ones are due. */
  submissionTimes(accountId: string, since: Date): Promise<Date[]>;
  recordSubmission(entry: { accountId: string; vertical: string; actionType: string; at: Date }): Promise<void>;
  queueSubmission(entry: { accountId: string; vertical: string; actionType: PacedActionType; payload: Record<string, unknown>; notBefore: Date }): Promise<OutboxEntry>;
  /** Queued entries due at `now`, oldest first. */
  dueSubmissions(now: Date, limit: number): Promise<OutboxEntry[]>;
  /** Moves an entry from queued to sending; false when another process took it. */
  claimSubmission(id: string): Promise<boolean>;
  finishSubmission(id: string, status: "sent" | "failed", result: unknown, at: Date): Promise<void>;
  /** Marks entries stuck in `sending` (a crash mid-send) as failed, and returns them. */
  failStaleSubmissions?(olderThan: Date, result: unknown): Promise<OutboxEntry[]>;
}

/** In memory, for tests and for a server without a database-backed store. */
export class MemorySubmissionStore implements SubmissionStore {
  readonly sent: { accountId: string; vertical: string; actionType: string; at: Date }[] = [];
  readonly outbox: OutboxEntry[] = [];
  private n = 0;
  async submissionTimes(accountId: string, since: Date): Promise<Date[]> {
    return [
      ...this.sent.filter((s) => s.accountId === accountId && s.at >= since).map((s) => s.at),
      ...this.outbox.filter((e) => e.accountId === accountId && (e.status === "queued" || e.status === "sending")).map((e) => new Date(e.notBefore)),
    ];
  }
  async recordSubmission(entry: { accountId: string; vertical: string; actionType: string; at: Date }): Promise<void> {
    this.sent.push(entry);
  }
  async queueSubmission(entry: { accountId: string; vertical: string; actionType: PacedActionType; payload: Record<string, unknown>; notBefore: Date }): Promise<OutboxEntry> {
    const row: OutboxEntry = { id: `outbox-${++this.n}`, accountId: entry.accountId, vertical: entry.vertical, actionType: entry.actionType, payload: entry.payload, notBefore: entry.notBefore.toISOString(), status: "queued", result: null, createdAt: new Date().toISOString() };
    this.outbox.push(row);
    return row;
  }
  async dueSubmissions(now: Date, limit: number): Promise<OutboxEntry[]> {
    return this.outbox
      .filter((e) => e.status === "queued" && e.notBefore <= now.toISOString())
      .sort((a, b) => a.notBefore.localeCompare(b.notBefore))
      .slice(0, limit);
  }
  async claimSubmission(id: string): Promise<boolean> {
    const e = this.outbox.find((x) => x.id === id);
    if (!e || e.status !== "queued") return false;
    e.status = "sending";
    return true;
  }
  async finishSubmission(id: string, status: "sent" | "failed", result: unknown, at: Date): Promise<void> {
    const e = this.outbox.find((x) => x.id === id);
    if (!e) return;
    e.status = status;
    e.result = result;
    if (status === "sent") this.sent.push({ accountId: e.accountId, vertical: e.vertical, actionType: e.actionType, at });
  }
}

/** The account may not submit yet. `retryAt` is when it could. */
export class PacingError extends Error {
  constructor(
    message: string,
    readonly retryAt: Date,
  ) {
    super(message);
    this.name = "PacingError";
  }
}

export function describeLimits(limits: PacingLimits): string {
  const parts: string[] = [];
  if (limits.minGapMs > 0) parts.push(`at least ${Math.round(limits.minGapMs / 60_000)} min between submissions`);
  if (limits.dailyCap < Number.MAX_SAFE_INTEGER) parts.push(`at most ${limits.dailyCap} in 24 hours`);
  return parts.join(" and ");
}

/** One account's submissions are decided one at a time, so two approvals can't take the same slot. */
export class Pacer {
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: SubmissionStore,
    private readonly now: () => Date,
  ) {}

  serial<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(accountId) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(accountId, run.catch(() => {}));
    return run;
  }

  /** The next free slot for an account: `now` when it may submit straight away. */
  async slot(account: SocialAccount, limits: PacingLimits): Promise<Date> {
    const now = this.now();
    const times = await this.store.submissionTimes(account.id, new Date(now.getTime() - DAY_MS - limits.minGapMs));
    return nextSlot(times, now, limits);
  }

  /** Runs `send` if the account may submit now and records it; otherwise throws a PacingError. */
  async guarded(account: SocialAccount, limits: PacingLimits, actionType: string, send: () => Promise<PublishResult>): Promise<PublishResult> {
    return this.serial(account.id, async () => {
      const slot = await this.slot(account, limits);
      if (slot.getTime() > this.now().getTime()) {
        throw new PacingError(`${platformLabel(account.platform)} account "${account.id}" is paced (${describeLimits(limits)}): the next submission can go at ${slot.toISOString()}`, slot);
      }
      const result = await send();
      await this.store.recordSubmission({ accountId: account.id, vertical: account.vertical, actionType, at: this.now() });
      return result;
    });
  }
}

export interface SendDueOptions {
  store: SubmissionStore;
  accounts: SocialAccount[];
  adapters: AdapterMap;
  /** Sends one queued entry through its adapter. The executors provide this (`sendQueued`). */
  send: (entry: OutboxEntry, account: SocialAccount, adapter: PlatformAdapter, ctx: AdapterContext) => Promise<PublishResult>;
  onFailure?: (entry: OutboxEntry, error: string) => Promise<void>;
  onSent?: (entry: OutboxEntry, result: PublishResult) => Promise<void>;
  fetch?: typeof fetch;
  logger?: AdapterLogger;
  now?: () => Date;
  /** An entry still `sending` after this long was interrupted. Default 15 min. */
  staleMs?: number;
}

/**
 * Sends queued submissions whose slot has come (run every minute by the server): at most one per
 * account per run, and only if the account's limits still allow it now, so a late run can't
 * release a burst. An entry is sent once: it is claimed first, then marked sent or failed. A
 * failure is reported and not retried (it may be Reddit saying no).
 */
export async function sendDueSubmissions(options: SendDueOptions): Promise<{ sent: number; failed: number; waiting: number }> {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? {
    info: (m: string) => console.log(`[social] ${m}`),
    error: (m: string, err?: unknown) => console.error(`[social] ${m}`, err ?? ""),
  };
  const ctx: AdapterContext = { fetch: options.fetch ?? fetch, log, now };
  let sent = 0;
  let failed = 0;
  let waiting = 0;
  const fail = async (entry: OutboxEntry, error: string) => {
    failed++;
    log.error(`queued ${entry.actionType} ${entry.id} (${entry.accountId}) failed: ${error}`);
    await options.onFailure?.(entry, error).catch((err) => log.error("could not report a failed submission", err));
  };

  const interrupted = "interrupted while sending; check the platform before sending it again";
  for (const entry of (await options.store.failStaleSubmissions?.(new Date(now().getTime() - (options.staleMs ?? 15 * 60_000)), { ok: false, error: interrupted })) ?? []) {
    await fail(entry, interrupted);
  }

  const seen = new Set<string>();
  for (const entry of await options.store.dueSubmissions(now(), 50)) {
    if (seen.has(entry.accountId)) {
      waiting++;
      continue;
    }
    seen.add(entry.accountId);
    const account = options.accounts.find((a) => a.id === entry.accountId);
    const adapter = account ? options.adapters[account.platform] : undefined;
    if (!account || !adapter) {
      if (await options.store.claimSubmission(entry.id)) {
        const error = `social account "${entry.accountId}" is no longer configured`;
        await options.store.finishSubmission(entry.id, "failed", { ok: false, error }, now());
        await fail(entry, error);
      }
      continue;
    }
    const limits = pacingFor(account, adapter);
    if (limits) {
      // Its own slot aside, has anything gone out since that makes now too soon?
      const since = new Date(now().getTime() - DAY_MS - limits.minGapMs);
      const out = (await options.store.submissionTimes(account.id, since)).filter((t) => t.getTime() <= now().getTime() && t.toISOString() !== entry.notBefore);
      if (nextSlot(out, now(), limits).getTime() > now().getTime()) {
        waiting++;
        continue;
      }
    }
    if (!(await options.store.claimSubmission(entry.id))) continue;
    try {
      const result = await options.send(entry, account, adapter, ctx);
      await options.store.finishSubmission(entry.id, "sent", { ok: true, id: result.id, url: result.url ?? null }, now());
      sent++;
      await options.onSent?.(entry, result).catch((err) => log.error(`after sending ${entry.id}`, err));
    } catch (err) {
      const error = (err as Error)?.message ?? String(err);
      await options.store.finishSubmission(entry.id, "failed", { ok: false, error }, now());
      await fail(entry, error);
    }
  }
  return { sent, failed, waiting };
}
