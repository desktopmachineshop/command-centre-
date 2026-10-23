import type { ImapConnector, ImapSession } from "./imap";

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
