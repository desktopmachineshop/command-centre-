/**
 * Exponential back-off after repeated failures: `free` failures are allowed, then
 * each further one blocks the key for base, 2x base, 4x base ... up to `maxMs`.
 * The same schedule drives the per-account lockout stored on the user row.
 */
export interface BackoffPolicy {
  free: number;
  baseMs: number;
  maxMs: number;
}

export const ACCOUNT_POLICY: BackoffPolicy = { free: 5, baseMs: 15_000, maxMs: 15 * 60_000 };
export const IP_POLICY: BackoffPolicy = { free: 20, baseMs: 15_000, maxMs: 15 * 60_000 };

/** How long to block after the `failures`-th consecutive failure (0 = not blocked). */
export function backoffMs(failures: number, p: BackoffPolicy): number {
  if (failures < p.free) return 0;
  return Math.min(p.maxMs, p.baseMs * 2 ** Math.min(30, failures - p.free));
}

type Entry = { failures: number; blockedUntil: number; lastFailure: number };

/**
 * In-memory failure counter per key (an IP, or an email that has no account).
 * Single replica only, like the rest of Phase 0's in-memory state.
 */
export class Throttle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly policy: BackoffPolicy,
    private readonly now: () => number = Date.now,
    /** Failures older than this are forgotten. */
    private readonly windowMs = 60 * 60_000,
  ) {}

  /** Milliseconds until the key may try again, or 0. */
  retryAfter(key: string): number {
    const e = this.live(key);
    return e ? Math.max(0, e.blockedUntil - this.now()) : 0;
  }

  fail(key: string): number {
    const now = this.now();
    const e = this.live(key) ?? { failures: 0, blockedUntil: 0, lastFailure: now };
    e.failures += 1;
    e.lastFailure = now;
    e.blockedUntil = now + backoffMs(e.failures, this.policy);
    this.entries.set(key, e);
    if (this.entries.size > 10_000) this.prune();
    return e.failures;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private live(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && this.now() - e.lastFailure > this.windowMs && this.now() >= e.blockedUntil) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private prune() {
    for (const key of [...this.entries.keys()]) this.live(key);
  }
}

/** Runs one task at a time per key, so parallel guesses can't all slip past a lockout check. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.catch(() => {}).then(task);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
