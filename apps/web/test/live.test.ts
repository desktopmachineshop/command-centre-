import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api";
import { LiveFeed, SILENCE_MS } from "../src/live";

/** A WebSocket the test drives: `open()` and `message()` play the server, `closed` records close(). */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  /** The server accepting the connection. */
  welcome() {
    this.onopen?.();
    this.message({ type: "welcome", role: "client" });
  }
  message(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const api = { wsUrl: "ws://cc.test/ws", token: "t" } as unknown as Api;
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

describe("LiveFeed", () => {
  let visibility: "visible" | "hidden";
  let listeners: (() => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    visibility = "visible";
    listeners = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_: string, l: () => void) => listeners.push(l),
      removeEventListener: (_: string, l: () => void) => (listeners = listeners.filter((x) => x !== l)),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const setVisible = (v: boolean) => {
    visibility = v ? "visible" : "hidden";
    for (const l of listeners) l();
  };

  it("says hello, passes messages on, and keeps pings to itself", () => {
    const feed = new LiveFeed(api);
    const got: string[] = [];
    feed.subscribe((m) => got.push(m.type));
    last().welcome();
    expect(JSON.parse(last().sent[0]!)).toEqual({ type: "hello", role: "client", token: "t" });
    last().message({ type: "ping" });
    last().message({ type: "org.updated" });
    expect(got).toEqual(["welcome", "org.updated"]);
    expect(feed.connected).toBe(true);
    feed.close();
  });

  it("asks pages to load again when the connection comes back, but not on the first connect", () => {
    const feed = new LiveFeed(api);
    let resyncs = 0;
    feed.onResync(() => resyncs++);
    last().welcome();
    expect(resyncs).toBe(0);

    last().close(); // the proxy dropped it
    expect(feed.connected).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    last().welcome();
    expect(resyncs).toBe(1);
    expect(feed.connected).toBe(true);
    feed.close();
  });

  it("replaces a connection that has gone silent, and stays on one the server keeps pinging", () => {
    const feed = new LiveFeed(api);
    let resyncs = 0;
    feed.onResync(() => resyncs++);
    last().welcome();
    // Pinged every 25 s: still the same socket after five minutes.
    for (let t = 0; t < 300_000; t += 25_000) {
      vi.advanceTimersByTime(25_000);
      last().message({ type: "ping" });
    }
    expect(FakeSocket.all).toHaveLength(1);

    // Then nothing: it is closed and a new one opened straight away.
    vi.advanceTimersByTime(SILENCE_MS + 15_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]!.closed).toBe(true);
    last().welcome();
    expect(resyncs).toBe(1);
    feed.close();
  });

  it("catches up when the app comes back to the foreground", () => {
    const feed = new LiveFeed(api);
    let resyncs = 0;
    feed.onResync(() => resyncs++);
    last().welcome();

    // A glance away is nothing.
    setVisible(false);
    vi.advanceTimersByTime(1000);
    setVisible(true);
    expect(resyncs).toBe(0);

    // Away a while with the connection still up: load again, same socket.
    setVisible(false);
    vi.advanceTimersByTime(20_000);
    last().message({ type: "ping" });
    setVisible(true);
    expect(resyncs).toBe(1);
    expect(FakeSocket.all).toHaveLength(1);

    // Away with the connection lost and the retry still waiting: connect now.
    setVisible(false);
    last().close();
    vi.advanceTimersByTime(1000);
    last().close(); // the retry failed too; the next is 2 s away
    vi.advanceTimersByTime(5000 - 1000);
    const before = FakeSocket.all.length;
    last().close();
    setVisible(true);
    expect(FakeSocket.all.length).toBe(before + 1);
    last().welcome();
    expect(resyncs).toBe(2);
    feed.close();
  });

  it("stops for good when closed", () => {
    const feed = new LiveFeed(api);
    last().welcome();
    feed.close();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
