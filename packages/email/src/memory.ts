import type { ImapConnector, ImapSession, MailSearch } from "./imap";
import { parseEmail } from "./parse";

/**
 * An in-memory IMAP stand-in for tests and local runs: `deliver()` drops a raw
 * message in, and its connector wakes any waiting poller like IDLE would.
 */
export class MemoryMailbox {
  uidValidity = "1";
  readonly messages: { uid: number; source: Buffer }[] = [];
  readonly sent: Buffer[] = [];
  /** Fail this many upcoming connects, to exercise reconnects. */
  failConnects = 0;
  connects = 0;
  private nextUid = 1;
  private readonly waiters = new Set<() => void>();

  deliver(source: Buffer | string): number {
    const uid = this.nextUid++;
    this.messages.push({ uid, source: Buffer.from(source) });
    for (const wake of this.waiters) wake();
    return uid;
  }

  /** Simulates the server renumbering its UIDs. */
  renumber(uidValidity: string) {
    this.uidValidity = uidValidity;
  }

  /** IMAP-like SEARCH over the delivered messages (dates compare by day, as IMAP does). */
  async search(c: MailSearch): Promise<number[]> {
    const has = (hay: string, needle?: string) => !needle || hay.toLowerCase().includes(needle.toLowerCase());
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const hits: number[] = [];
    for (const m of this.messages) {
      const mail = await parseEmail(m.source);
      const from = mail.from ? `${mail.from.name} ${mail.from.address}` : "";
      const id = (mail.messageId ?? "").replace(/^<|>$/g, "");
      if (!has(from, c.from) || !has(mail.subject, c.subject) || !has(mail.text, c.text)) continue;
      if (c.messageId && id !== c.messageId.trim().replace(/^<|>$/g, "")) continue;
      const date = mail.date ? day(new Date(mail.date)) : null;
      if (c.since && (!date || date < day(c.since))) continue;
      if (c.before && (!date || date >= day(c.before))) continue;
      hits.push(m.uid);
    }
    return hits;
  }

  readonly connector: ImapConnector = async () => {
    this.connects++;
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error("connection refused (simulated)");
    }
    let closed = false;
    const session: ImapSession = {
      open: async () => ({ uidValidity: this.uidValidity, uidNext: this.nextUid }),
      uidsAfter: async (lastUid) => this.messages.filter((m) => m.uid > lastUid).map((m) => m.uid),
      search: (criteria) => this.search(criteria),
      fetchSource: async (uid) => this.messages.find((m) => m.uid === uid)?.source ?? null,
      waitForMail: (timeoutMs, signal) =>
        new Promise<void>((resolve, reject) => {
          if (closed) return reject(new Error("closed"));
          const done = () => {
            clearTimeout(timer);
            this.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, timeoutMs);
          this.waiters.add(done);
          signal.addEventListener("abort", done, { once: true });
        }),
      appendToSent: async (raw) => {
        this.sent.push(raw);
        return "Sent";
      },
      close: async () => {
        closed = true;
      },
    };
    return session;
  };
}
