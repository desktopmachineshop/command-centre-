import type { NewEvent } from "@cc/core";
import { type AdapterMap, normaliseHandle } from "./accounts";
import { authorLabel, clip, oneLine } from "./prompt";
import type { AdapterContext, AdapterLogger, InboundItem, PlatformAdapter, SocialAccount } from "./types";

/** Where each account's poll cursor is kept. The server's Store implements this. */
export interface SocialCheckpointStore {
  getSocialCheckpoint(accountId: string): Promise<string | null>;
  saveSocialCheckpoint(accountId: string, cursor: string | null): Promise<void>;
}

export interface SocialInboundOptions {
  accounts: SocialAccount[];
  adapters: AdapterMap;
  store: SocialCheckpointStore;
  ingest: (event: NewEvent) => Promise<unknown>;
  /** Poll interval for adapters that don't suggest one. Default 300 s. */
  defaultPollSeconds?: number;
  /** Delay after a failure; doubles each time up to `maxMs`. Default 30 s to 15 min. */
  backoff?: { initialMs: number; maxMs: number };
  /** ± fraction of the poll interval added at random, so accounts don't poll in lockstep. Default 0.1. */
  jitter?: number;
  /** Called for each failed poll or connection (the server alerts Dave when it is an expired sign-in). */
  onError?: (account: SocialAccount, err: unknown) => void;
  fetch?: typeof fetch;
  logger?: AdapterLogger;
  now?: () => Date;
  random?: () => number;
}

/** The event an inbound item becomes. Exported for tests and other sources. */
export function socialEvent(account: SocialAccount, item: InboundItem): NewEvent & { payload: Record<string, unknown> } {
  return {
    source: "social",
    vertical: account.vertical,
    kind: item.kind,
    title: `${account.platform} ${item.kind} from ${authorLabel(item.author)}: ${clip(oneLine(item.text ?? ""), 80) || "(no text)"}`,
    payload: {
      accountId: account.id,
      platform: account.platform,
      accountHandle: account.handle ?? null,
      item,
    },
    dedupeKey: `social:${account.id}:${item.id}`,
  };
}

/** True when the account itself wrote the item (its own posts and replies come back as inbound). */
export function isOwnItem(account: SocialAccount, item: InboundItem): boolean {
  const selfId = account.options.userId;
  if (typeof selfId === "string" && selfId && item.author?.id === selfId) return true;
  const own = normaliseHandle(account.handle);
  return own !== null && normaliseHandle(item.author?.handle) === own;
}

/**
 * Watches every `inbound: true` account whose adapter can read, by polling with
 * an opaque cursor or through a live `listen` connection. Each account runs on
 * its own: a failure is logged and retried with backoff, and never touches the
 * other accounts or the server. A cursor is saved only after every item it
 * covers was ingested, so a failed ingest means the items are fetched again
 * (the dedupe key keeps that harmless).
 */
export class SocialInbound {
  private readonly abort = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly stops = new Set<() => Promise<void>>();
  private readonly log: AdapterLogger;

  constructor(private readonly options: SocialInboundOptions) {
    this.log = options.logger ?? {
      info: (m) => console.log(`[social] ${m}`),
      error: (m, err) => console.error(`[social] ${m}`, err ?? ""),
    };
  }

  /** The accounts that will be watched, with the adapter and mode for each. */
  watched(): { account: SocialAccount; adapter: PlatformAdapter; mode: "poll" | "listen" }[] {
    const out: { account: SocialAccount; adapter: PlatformAdapter; mode: "poll" | "listen" }[] = [];
    for (const account of this.options.accounts) {
      if (!account.inbound) continue;
      const adapter = this.options.adapters[account.platform];
      const source = adapter?.inbound;
      if (!adapter || !source || !adapter.capabilities.inbound) continue;
      if (source.listen) out.push({ account, adapter, mode: "listen" });
      else if (source.poll) out.push({ account, adapter, mode: "poll" });
    }
    return out;
  }

  start(): void {
    for (const { account, adapter, mode } of this.watched()) {
      this.loops.push(mode === "listen" ? this.listen(account, adapter) : this.poll(account, adapter));
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.all([...this.stops].map((stop) => stop().catch((err) => this.log.error("error closing a connection", err))));
    await Promise.all(this.loops);
  }

  private get stopped() {
    return this.abort.signal.aborted;
  }

  private context(account: SocialAccount): AdapterContext {
    const prefix = `${account.id}: `;
    return {
      fetch: this.options.fetch ?? fetch,
      log: { info: (m) => this.log.info(prefix + m), error: (m, err) => this.log.error(prefix + m, err) },
      now: this.options.now ?? (() => new Date()),
      signal: this.abort.signal,
    };
  }

  private backoff() {
    const { initialMs, maxMs } = this.options.backoff ?? { initialMs: 30_000, maxMs: 15 * 60_000 };
    let delay = initialMs;
    return {
      next: () => {
        const d = delay;
        delay = Math.min(delay * 2, maxMs);
        return d;
      },
      reset: () => (delay = initialMs),
    };
  }

  private intervalMs(adapter: PlatformAdapter, account: SocialAccount): number {
    const seconds = adapter.inbound?.pollIntervalFor?.(account) ?? adapter.inbound?.pollIntervalSeconds ?? this.options.defaultPollSeconds ?? 300;
    const jitter = this.options.jitter ?? 0.1;
    const random = this.options.random ?? Math.random;
    return Math.max(0, seconds * 1000 * (1 + jitter * (2 * random() - 1)));
  }

  private async handle(account: SocialAccount, item: InboundItem): Promise<void> {
    if (isOwnItem(account, item)) return;
    await this.options.ingest(socialEvent(account, item));
  }

  private async poll(account: SocialAccount, adapter: PlatformAdapter): Promise<void> {
    const ctx = this.context(account);
    const backoff = this.backoff();
    let cursor: string | null | undefined;
    while (!this.stopped) {
      let wait: number;
      try {
        if (cursor === undefined) {
          cursor = await this.options.store.getSocialCheckpoint(account.id);
          this.log.info(`${account.id}: polling ${account.platform}${cursor ? "" : " (first run)"}`);
        }
        const result = await adapter.inbound!.poll!(account, cursor, ctx);
        for (const item of result.items) {
          if (this.stopped) return;
          await this.handle(account, item);
        }
        if (result.cursor !== cursor) {
          await this.options.store.saveSocialCheckpoint(account.id, result.cursor);
          cursor = result.cursor;
        }
        backoff.reset();
        wait = this.intervalMs(adapter, account);
      } catch (err) {
        if (this.stopped) return;
        wait = backoff.next();
        this.log.error(`${account.id}: poll failed: ${(err as Error).message}; retrying in ${Math.round(wait / 1000)}s`, err);
        try {
          this.options.onError?.(account, err);
        } catch {
          // Reporting is best effort.
        }
      }
      await sleep(wait, this.abort.signal);
    }
  }

  private async listen(account: SocialAccount, adapter: PlatformAdapter): Promise<void> {
    const ctx = this.context(account);
    const backoff = this.backoff();
    const emit = async (item: InboundItem) => {
      try {
        await this.handle(account, item);
      } catch (err) {
        this.log.error(`${account.id}: could not ingest ${item.kind} ${item.id}`, err);
        throw err;
      }
    };
    while (!this.stopped) {
      try {
        const stop = await adapter.inbound!.listen!(account, emit, ctx);
        if (this.stopped) {
          await stop().catch(() => {});
          return;
        }
        this.stops.add(stop);
        this.log.info(`${account.id}: listening on ${account.platform}`);
        // The adapter keeps its own connection alive; this loop only retries a failed start.
        return;
      } catch (err) {
        if (this.stopped) return;
        const wait = backoff.next();
        this.log.error(`${account.id}: could not connect: ${(err as Error).message}; retrying in ${Math.round(wait / 1000)}s`, err);
        await sleep(wait, this.abort.signal);
      }
    }
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => (clearTimeout(timer), resolve());
    const timer = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
