import type { NewEvent } from "@cc/core";
import { afterEach, describe, expect, it } from "vitest";
import { type EmailCheckpointStore, EmailPoller, MemoryMailbox } from "../src";
import { account, rawEmail } from "./fixtures";

class MemoryCheckpoints implements EmailCheckpointStore {
  readonly rows = new Map<string, { uidValidity: string; lastUid: number }>();
  async getEmailCheckpoint(id: string) {
    return this.rows.get(id) ?? null;
  }
  async saveEmailCheckpoint(id: string, c: { uidValidity: string; lastUid: number }) {
    this.rows.set(id, c);
  }
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const quiet = { info: () => {}, error: () => {} };
const mail = (from: string, id: string, subject = "Hello") =>
  rawEmail({ from, to: "support@desktopmachineshop.com", subject, messageId: id, text: "Body" });

describe("EmailPoller", () => {
  let poller: EmailPoller | undefined;
  afterEach(async () => poller?.stop());

  function setup(options: { mailbox?: MemoryMailbox; store?: MemoryCheckpoints; ingest?: (e: NewEvent) => Promise<unknown> } = {}) {
    const mailbox = options.mailbox ?? new MemoryMailbox();
    const store = options.store ?? new MemoryCheckpoints();
    const events: NewEvent[] = [];
    poller = new EmailPoller({
      accounts: [account({ ignoreFrom: ["@spam.example"] })],
      store,
      ingest: options.ingest ?? (async (e) => events.push(e)),
      connect: mailbox.connector,
      pollIntervalMs: 60_000,
      backoff: { initialMs: 10, maxMs: 20 },
      logger: quiet,
    });
    poller.start();
    return { mailbox, store, events };
  }

  it("starts from the newest message, then ingests new mail as it arrives", async () => {
    const mailbox = new MemoryMailbox();
    mailbox.deliver(await mail("old@example.com", "<old@example.com>"));
    const { store, events } = setup({ mailbox });
    await waitFor(() => store.rows.has("shop"));
    expect(store.rows.get("shop")).toEqual({ uidValidity: "1", lastUid: 1 });

    mailbox.deliver(await mail('"Jane Doe" <jane@example.com>', "<m2@example.com>", "ER11 collets"));
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      source: "email",
      vertical: "dms",
      kind: "message",
      title: "Jane Doe: ER11 collets",
      dedupeKey: "email:shop:<m2@example.com>",
      payload: { accountId: "shop", messageId: "<m2@example.com>", from: { address: "jane@example.com" } },
    });
    await waitFor(() => store.rows.get("shop")?.lastUid === 2);
  });

  it("skips ignored senders and the account's own mail, but still advances the checkpoint", async () => {
    const { mailbox, store, events } = setup();
    await waitFor(() => store.rows.has("shop"));
    mailbox.deliver(await mail("news@spam.example", "<s@spam.example>"));
    mailbox.deliver(await mail("support@desktopmachineshop.com", "<self@dms>"));
    mailbox.deliver(await mail("jane@example.com", "<j@example.com>"));
    await waitFor(() => store.rows.get("shop")?.lastUid === 3);
    expect(events.map((e) => e.dedupeKey)).toEqual(["email:shop:<j@example.com>"]);
  });

  it("resumes from the saved UID after a restart, without re-ingesting", async () => {
    const mailbox = new MemoryMailbox();
    const store = new MemoryCheckpoints();
    const first = setup({ mailbox, store });
    await waitFor(() => store.rows.has("shop"));
    mailbox.deliver(await mail("a@example.com", "<a@example.com>"));
    await waitFor(() => first.events.length === 1);
    await poller!.stop();

    // Mail that arrives while the server is down is picked up on the next start.
    mailbox.deliver(await mail("b@example.com", "<b@example.com>"));
    const second = setup({ mailbox, store });
    await waitFor(() => second.events.length === 1);
    expect(second.events[0]!.dedupeKey).toBe("email:shop:<b@example.com>");
    expect(store.rows.get("shop")).toEqual({ uidValidity: "1", lastUid: 2 });
  });

  it("resets the checkpoint when UIDVALIDITY changes", async () => {
    const mailbox = new MemoryMailbox();
    const store = new MemoryCheckpoints();
    store.rows.set("shop", { uidValidity: "old", lastUid: 999 });
    mailbox.deliver(await mail("a@example.com", "<a@example.com>"));
    setup({ mailbox, store });
    await waitFor(() => store.rows.get("shop")?.uidValidity === "1");
    expect(store.rows.get("shop")!.lastUid).toBe(1);
  });

  it("reconnects with backoff after failures and retries a message whose ingest failed", async () => {
    const mailbox = new MemoryMailbox();
    mailbox.failConnects = 2;
    let fail = true;
    const events: NewEvent[] = [];
    const { store } = setup({
      mailbox,
      ingest: async (e) => {
        if (fail) {
          fail = false;
          throw new Error("database down");
        }
        events.push(e);
      },
    });
    await waitFor(() => store.rows.has("shop"));
    expect(mailbox.connects).toBe(3);

    mailbox.deliver(await mail("a@example.com", "<a@example.com>"));
    await waitFor(() => events.length === 1);
    expect(mailbox.connects).toBe(4);
    expect(store.rows.get("shop")!.lastUid).toBe(1);
  });

  it("uses the UID in the dedupe key when there is no Message-ID", async () => {
    const { mailbox, store, events } = setup();
    await waitFor(() => store.rows.has("shop"));
    const raw = (await mail("a@example.com", "<x@example.com>")).toString().replace(/^Message-ID:.*\r\n/im, "");
    mailbox.deliver(raw);
    await waitFor(() => events.length === 1);
    expect(events[0]!.dedupeKey).toBe("email:shop:uid:1:1");
  });

  it("gives the same dedupe key to a message seen twice", async () => {
    const { mailbox, store, events } = setup();
    await waitFor(() => store.rows.has("shop"));
    const raw = await mail("a@example.com", "<same@example.com>");
    mailbox.deliver(raw);
    mailbox.deliver(raw);
    await waitFor(() => events.length === 2);
    expect(events[0]!.dedupeKey).toBe(events[1]!.dedupeKey);
  });
});
