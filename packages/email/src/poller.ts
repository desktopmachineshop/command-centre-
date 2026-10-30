import type { NewEvent } from "@cc/core";
import { type EmailAccount, isIgnoredSender } from "./accounts";
import { canFileInGmail } from "./gmail";
import { type ImapConnector, type ImapSession, imapflowConnector } from "./imap";
import { type EmailPayload, parseEmail } from "./parse";

/** Where each account's progress is kept. The server's Store implements this. */
export interface EmailCheckpointStore {
  getEmailCheckpoint(accountId: string): Promise<{ uidValidity: string; lastUid: number } | null>;
  saveEmailCheckpoint(accountId: string, checkpoint: { uidValidity: string; lastUid: number }): Promise<void>;
}

export interface Logger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface EmailPollerOptions {
  accounts: EmailAccount[];
  store: EmailCheckpointStore;
  ingest: (event: NewEvent) => Promise<unknown>;
  /** Re-check interval. New mail usually arrives sooner, through IDLE. */
  pollIntervalMs?: number;
  connect?: ImapConnector;
  /** Reconnect delay after a failure; doubles each time up to `max`. */
  backoff?: { initialMs: number; maxMs: number };
  logger?: Logger;
}

/** The event an email becomes. Exported for tests and other mail sources. */
export function emailEvent(
  account: EmailAccount,
  email: EmailPayload,
  fallbackId: string,
): NewEvent & { payload: Record<string, unknown> } {
  const who = email.from?.name || email.from?.address || "unknown sender";
  return {
    source: "email",
    vertical: account.vertical,
    kind: "message",
    title: `${who}: ${email.subject || "(no subject)"}`,
    payload: {
      accountId: account.id,
      account: account.address,
      accountName: account.displayName ?? null,
      // Gmail inboxes connected with Google can be labelled and archived (email.label).
      canLabel: canFileInGmail(account),
      mailbox: account.mailbox,
      ...email,
    },
    dedupeKey: `email:${account.id}:${email.messageId ?? fallbackId}`,
  };
}

/**
 * Watches each account's mailbox and ingests new messages. One loop per
 * account: connect, catch up from the last seen UID, then wait for IDLE news
 * or the poll interval. Failures reconnect with backoff and never touch the
 * other accounts or the server.
 */
export class EmailPoller {
  private readonly abort = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly sessions = new Set<ImapSession>();
  private readonly connect: ImapConnector;
  private readonly log: Logger;

  constructor(private readonly options: EmailPollerOptions) {
    this.connect = options.connect ?? imapflowConnector;
    this.log = options.logger ?? {
      info: (m) => console.log(`[email] ${m}`),
      error: (m, err) => console.error(`[email] ${m}`, err ?? ""),
    };
  }

  start(): void {
    for (const account of this.options.accounts) this.loops.push(this.run(account));
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.all([...this.sessions].map((s) => s.close().catch(() => {})));
    await Promise.all(this.loops);
  }

  private get stopped() {
    return this.abort.signal.aborted;
  }

  private async run(account: EmailAccount): Promise<void> {
    const { initialMs, maxMs } = this.options.backoff ?? { initialMs: 5_000, maxMs: 5 * 60_000 };
    let delay = initialMs;
    while (!this.stopped) {
      let session: ImapSession | null = null;
      try {
        session = await this.connect(account);
        this.sessions.add(session);
        if (this.stopped) break;
        await this.watch(account, session, () => (delay = initialMs));
      } catch (err) {
        if (this.stopped) break;
        this.log.error(`${account.id}: ${(err as Error).message}; retrying in ${Math.round(delay / 1000)}s`, err);
        await sleep(delay, this.abort.signal);
        delay = Math.min(delay * 2, maxMs);
      } finally {
        if (session) {
          this.sessions.delete(session);
          await session.close().catch(() => {});
        }
      }
    }
  }

  private async watch(account: EmailAccount, session: ImapSession, connected: () => void): Promise<void> {
    const box = await session.open(account.mailbox);
    connected();
    let checkpoint = await this.options.store.getEmailCheckpoint(account.id);
    if (!checkpoint || checkpoint.uidValidity !== box.uidValidity) {
      // First run (or the server renumbered): start from now rather than replaying the whole mailbox.
      if (checkpoint) this.log.info(`${account.id}: UIDVALIDITY changed, skipping to the newest message`);
      checkpoint = { uidValidity: box.uidValidity, lastUid: Math.max(0, box.uidNext - 1) };
      await this.options.store.saveEmailCheckpoint(account.id, checkpoint);
    }
    this.log.info(`${account.id}: watching ${account.mailbox} from UID ${checkpoint.lastUid}`);

    const interval = this.options.pollIntervalMs ?? 5 * 60_000;
    while (!this.stopped) {
      const uids = await session.uidsAfter(checkpoint.lastUid);
      for (const uid of uids) {
        if (this.stopped) return;
        await this.processMessage(account, session, box.uidValidity, uid);
        checkpoint = { uidValidity: box.uidValidity, lastUid: uid };
        await this.options.store.saveEmailCheckpoint(account.id, checkpoint);
      }
      // Look again before waiting: more mail may have landed while we worked.
      if (uids.length === 0) await session.waitForMail(interval, this.abort.signal);
    }
  }

  /** Parses and ingests one message. Unparseable mail is logged and skipped; ingest errors propagate so it is retried. */
  private async processMessage(account: EmailAccount, session: ImapSession, uidValidity: string, uid: number) {
    const source = await session.fetchSource(uid);
    if (!source) return;
    let email: EmailPayload;
    try {
      email = await parseEmail(source);
    } catch (err) {
      this.log.error(`${account.id}: could not parse UID ${uid}, skipping`, err);
      return;
    }
    if (isIgnoredSender(account, email.from?.address)) return;
    await this.options.ingest(emailEvent(account, email, `uid:${uidValidity}:${uid}`));
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
