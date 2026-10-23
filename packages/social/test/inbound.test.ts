import type { NewEvent } from "@cc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InboundItem, type PollResult, type SocialCheckpointStore, SocialInbound } from "../src";
import { account, fakeAdapter, item } from "./fakes";

class MemoryCheckpoints implements SocialCheckpointStore {
  readonly cursors = new Map<string, string | null>();
  async getSocialCheckpoint(id: string) {
    return this.cursors.get(id) ?? null;
  }
  async saveSocialCheckpoint(id: string, cursor: string | null) {
    this.cursors.set(id, cursor);
  }
}

const quietLog = () => ({ info: vi.fn(), error: vi.fn() });

/** A poll adapter driven by a queue of results (or errors), one per call. */
function pollAdapter(platform: "instagram" | "x", script: (PollResult | Error)[], pollIntervalSeconds = 60) {
  const calls: (string | null)[] = [];
  const adapter = fakeAdapter(platform, {}, {
    inbound: {
      pollIntervalSeconds,
      async poll(_account, cursor) {
        calls.push(cursor);
        const next = script.shift() ?? { items: [], cursor };
        if (next instanceof Error) throw next;
        return next;
      },
    },
  });
  return { adapter, calls };
}

/** Lets pending promise chains (store, ingest) settle under fake timers. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("SocialInbound polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ingests new items as social events and saves the cursor after them", async () => {
    const store = new MemoryCheckpoints();
    const { adapter, calls } = pollAdapter("instagram", [
      { items: [], cursor: "c1" },
      { items: [item("a"), item("b", { author: { id: "u2", handle: "bob" }, text: "x".repeat(100) })], cursor: "c2" },
    ]);
    const events: NewEvent[] = [];
    const inbound = new SocialInbound({
      accounts: [account({ id: "3dp-ig", platform: "instagram", handle: "@3dpandme" })],
      adapters: { instagram: adapter },
      store,
      ingest: async (e) => void events.push(e),
      jitter: 0,
      logger: quietLog(),
    });
    inbound.start();
    await flush();
    expect(calls).toEqual([null]);
    expect(store.cursors.get("3dp-ig")).toBe("c1");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([null, "c1"]);
    expect(store.cursors.get("3dp-ig")).toBe("c2");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      source: "social",
      vertical: "3dpandme",
      kind: "comment",
      title: "instagram comment from @jane: Comment a",
      payload: { accountId: "3dp-ig", platform: "instagram", accountHandle: "@3dpandme", item: item("a") },
      dedupeKey: "social:3dp-ig:a",
    });
    expect(events[1]!.title).toBe(`instagram comment from @bob: ${"x".repeat(80)}…`);
    await inbound.stop();
  });

  it("does not save the cursor when an ingest fails, so the items come again", async () => {
    const store = new MemoryCheckpoints();
    store.cursors.set("acct", "c1");
    const batch = { items: [item("a"), item("b")], cursor: "c2" };
    const { adapter, calls } = pollAdapter("instagram", [batch, batch]);
    let failNext = true;
    const ingested: string[] = [];
    const log = quietLog();
    const inbound = new SocialInbound({
      accounts: [account({ id: "acct", platform: "instagram" })],
      adapters: { instagram: adapter },
      store,
      ingest: async (e) => {
        if (e.dedupeKey === "social:acct:b" && failNext) {
          failNext = false;
          throw new Error("database down");
        }
        ingested.push(e.dedupeKey!);
      },
      jitter: 0,
      logger: log,
    });
    inbound.start();
    await flush();
    expect(ingested).toEqual(["social:acct:a"]);
    expect(store.cursors.get("acct")).toBe("c1");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("database down; retrying in 30s"), expect.any(Error));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual(["c1", "c1"]);
    expect(ingested).toEqual(["social:acct:a", "social:acct:a", "social:acct:b"]);
    expect(store.cursors.get("acct")).toBe("c2");
    await inbound.stop();
  });

  it("skips items written by the account itself", async () => {
    const store = new MemoryCheckpoints();
    store.cursors.set("acct", "c0");
    const { adapter } = pollAdapter("x", [
      {
        items: [
          item("own-handle", { author: { id: "9", handle: "@3DPandMe" } }),
          item("own-id", { author: { id: "self-123", name: "Us" } }),
          item("theirs"),
        ],
        cursor: "c1",
      },
    ]);
    const keys: string[] = [];
    const inbound = new SocialInbound({
      accounts: [account({ id: "acct", platform: "x", handle: "3dpandme", options: { userId: "self-123" } })],
      adapters: { x: adapter },
      store,
      ingest: async (e) => void keys.push(e.dedupeKey!),
      logger: quietLog(),
    });
    inbound.start();
    await flush();
    expect(keys).toEqual(["social:acct:theirs"]);
    await inbound.stop();
  });

  it("backs off exponentially up to 15 minutes, per account, without stopping the others", async () => {
    const store = new MemoryCheckpoints();
    const broken = pollAdapter("x", Array.from({ length: 10 }, () => new Error("rate limited")));
    const healthy = pollAdapter("instagram", [], 60);
    const log = quietLog();
    const inbound = new SocialInbound({
      accounts: [account({ id: "bad", platform: "x" }), account({ id: "good", platform: "instagram" })],
      adapters: { x: broken.adapter, instagram: healthy.adapter },
      store,
      ingest: async () => {},
      jitter: 0,
      logger: log,
    });
    inbound.start();
    await flush();
    // 30s, 60s, 120s, 240s, 480s, then capped at 900s.
    const waits = [30, 60, 120, 240, 480, 900, 900];
    for (const [i, s] of waits.entries()) {
      expect(broken.calls).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(s * 1000 - 1);
      expect(broken.calls).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    const messages = log.error.mock.calls.map((c) => c[0] as string);
    expect(messages.slice(0, 7).map((m) => /retrying in (\d+)s/.exec(m)![1])).toEqual(["30", "60", "120", "240", "480", "900", "900"]);
    // The healthy account kept polling every minute meanwhile.
    expect(healthy.calls.length).toBeGreaterThan(40);
    await inbound.stop();
  });

  it("uses the default interval with jitter when the adapter suggests none", async () => {
    const store = new MemoryCheckpoints();
    const calls: (string | null)[] = [];
    const adapter = fakeAdapter("instagram", {}, {
      inbound: { poll: async (_a, cursor) => (calls.push(cursor), { items: [], cursor: "c" }) },
    });
    const inbound = new SocialInbound({
      accounts: [account({ id: "acct", platform: "instagram" })],
      adapters: { instagram: adapter },
      store,
      ingest: async () => {},
      defaultPollSeconds: 100,
      jitter: 0.1,
      random: () => 1, // the largest jitter: +10%
      logger: quietLog(),
    });
    inbound.start();
    await flush();
    await vi.advanceTimersByTimeAsync(109_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await inbound.stop();
  });

  it("only watches inbound accounts whose adapter can read", () => {
    const poller = pollAdapter("instagram", []).adapter;
    const inbound = new SocialInbound({
      accounts: [
        account({ id: "on", platform: "instagram" }),
        account({ id: "off", platform: "instagram", inbound: false }),
        account({ id: "no-source", platform: "x" }),
        account({ id: "no-tier", platform: "threads" }),
      ],
      adapters: {
        instagram: poller,
        x: fakeAdapter("x"),
        threads: fakeAdapter("threads", { inbound: false }, { inbound: { poll: async () => ({ items: [], cursor: null }) } }),
      },
      store: new MemoryCheckpoints(),
      ingest: async () => {},
    });
    expect(inbound.watched().map((w) => [w.account.id, w.mode])).toEqual([["on", "poll"]]);
  });
});

describe("SocialInbound listen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ingests emitted items, retries a failed connection, and stops the connection", async () => {
    let emit: ((i: InboundItem) => Promise<void>) | undefined;
    let attempts = 0;
    const stop = vi.fn(async () => {});
    const adapter = fakeAdapter("instagram", {}, {
      inbound: {
        async listen(_account, e) {
          if (++attempts === 1) throw new Error("gateway refused");
          emit = e;
          return stop;
        },
      },
    });
    const events: NewEvent[] = [];
    const log = quietLog();
    const inbound = new SocialInbound({
      accounts: [account({ id: "discord", platform: "instagram", handle: "bot" })],
      adapters: { instagram: adapter },
      store: new MemoryCheckpoints(),
      ingest: async (e) => void events.push(e),
      logger: log,
    });
    inbound.start();
    await flush();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("gateway refused; retrying in 30s"), expect.any(Error));
    expect(emit).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(2);

    await emit!(item("m1", { kind: "message" }));
    await emit!(item("m2", { author: { id: "b", handle: "bot" } })); // our own
    expect(events.map((e) => e.dedupeKey)).toEqual(["social:discord:m1"]);
    expect(events[0]!.kind).toBe("message");

    await inbound.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("passes an ingest failure back to the adapter", async () => {
    let emit: ((i: InboundItem) => Promise<void>) | undefined;
    const adapter = fakeAdapter("instagram", {}, { inbound: { listen: async (_a, e) => ((emit = e), async () => {}) } });
    const inbound = new SocialInbound({
      accounts: [account({ id: "acct", platform: "instagram" })],
      adapters: { instagram: adapter },
      store: new MemoryCheckpoints(),
      ingest: async () => {
        throw new Error("nope");
      },
      logger: quietLog(),
    });
    inbound.start();
    await flush();
    await expect(emit!(item("a"))).rejects.toThrow("nope");
    await inbound.stop();
  });
});
