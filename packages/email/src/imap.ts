import { ImapFlow } from "imapflow";
import type { EmailAccount } from "./accounts";

/**
 * The few IMAP operations the poller and executors need. `imapflowConnector`
 * is the real one; tests inject a fake.
 */
export interface ImapSession {
  /** Selects a mailbox. `uidValidity` changes when the server renumbers its UIDs. */
  open(mailbox: string): Promise<{ uidValidity: string; uidNext: number }>;
  /** UIDs above `lastUid` in the open mailbox, ascending. */
  uidsAfter(lastUid: number): Promise<number[]>;
  /** The raw RFC 822 source of one message, or null if it has gone. */
  fetchSource(uid: number): Promise<Buffer | null>;
  /**
   * Resolves when the server reports new mail (IDLE, or the client's own NOOP
   * polling where IDLE is missing), after `timeoutMs`, or on `signal` abort.
   * Rejects if the connection drops.
   */
  waitForMail(timeoutMs: number, signal: AbortSignal): Promise<void>;
  /** Appends a sent message to the Sent folder; returns its path, or null if there is none. */
  appendToSent(raw: Buffer): Promise<string | null>;
  close(): Promise<void>;
}

export type ImapConnector = (account: EmailAccount) => Promise<ImapSession>;

/** Names to try when the server does not flag a `\Sent` special-use folder. */
const SENT_NAMES = ["Sent", "Sent Items", "Sent Messages", "INBOX.Sent", "[Gmail]/Sent Mail"];

export const imapflowConnector: ImapConnector = async (account) => {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.imap.user, pass: account.imap.pass },
    logger: false,
  });
  // Without a listener an 'error' event would crash the process.
  let lastError: Error | null = null;
  client.on("error", (err: Error) => {
    lastError = err;
  });
  await client.connect();

  return {
    async open(mailbox) {
      const box = await client.mailboxOpen(mailbox);
      return { uidValidity: box.uidValidity.toString(), uidNext: box.uidNext };
    },
    async uidsAfter(lastUid) {
      const uids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      // "N:*" always matches the newest message, even when its UID is below N.
      return (uids || []).filter((u) => u > lastUid).sort((a, b) => a - b);
    },
    async fetchSource(uid) {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      return msg && msg.source ? msg.source : null;
    },
    waitForMail(timeoutMs, signal) {
      return new Promise<void>((resolve, reject) => {
        const done = (err?: Error) => {
          clearTimeout(timer);
          client.off("exists", onExists);
          client.off("close", onClose);
          signal.removeEventListener("abort", onAbort);
          err ? reject(err) : resolve();
        };
        const onExists = () => done();
        const onAbort = () => done();
        const onClose = () => done(lastError ?? new Error("IMAP connection closed"));
        const timer = setTimeout(() => done(), timeoutMs);
        if (!client.usable) return onClose();
        client.on("exists", onExists);
        client.on("close", onClose);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    async appendToSent(raw) {
      const boxes = await client.list();
      const sent =
        boxes.find((b) => b.specialUse === "\\Sent") ??
        boxes.find((b) => SENT_NAMES.some((n) => n.toLowerCase() === b.path.toLowerCase()));
      if (!sent) return null;
      await client.append(sent.path, raw, ["\\Seen"]);
      return sent.path;
    },
    async close() {
      try {
        if (client.usable) await client.logout();
      } finally {
        client.close();
      }
    },
  };
};
