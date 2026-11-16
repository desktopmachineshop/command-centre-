import type { OutboundMessage } from "@cc/core";
import { useEffect, useRef, useState } from "react";
import type { Api } from "./api";

type Listener = (msg: OutboundMessage) => void;

/** The server pings every 25 s (Hub.startHeartbeat); this long without anything means the connection is dead. */
export const SILENCE_MS = 70_000;
/** Back in the app after at least this long in the background: catch up, in case messages were missed. */
const AWAY_MS = 3_000;

/**
 * One WebSocket per app session, reconnecting with backoff.
 *
 * Live messages are not replayed: whatever was sent while the connection was down (a phone
 * with the app in the background, a proxy closing a quiet socket, a deploy) is gone. So when
 * the connection comes back, or the app returns to the foreground, the feed calls its `resync`
 * listeners and every page loads its data again (`useLoad` does this by itself; `useResync`
 * is for pages that keep their own state, like Chat).
 */
export class LiveFeed {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly resyncListeners = new Set<() => void>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Whether it has ever been connected: the first welcome is a start, later ones a reconnect. */
  private wasConnected = false;
  private lastSeen = Date.now();
  private hiddenAt: number | null = null;
  connected = false;
  onStatus: (connected: boolean) => void = () => {};

  constructor(private readonly api: Api) {
    this.open();
    this.watchdog = setInterval(() => this.checkAlive(), 15_000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** With cookie sign-in the upgrade request carries the session, so the hello token is empty. */
  private open() {
    this.retryTimer = null;
    const ws = new WebSocket(this.api.wsUrl);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "client", token: this.api.token ?? "" }));
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastSeen = Date.now();
      const msg = JSON.parse(e.data) as OutboundMessage;
      if (msg.type === "ping") return;
      if (msg.type === "welcome") {
        this.retry = 0;
        this.setStatus(true);
        if (this.wasConnected) this.resync();
        this.wasConnected = true;
      }
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.setStatus(false);
      if (this.closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  /** Drops the current socket (if any) and connects again now, without waiting out the backoff. */
  private reconnectNow() {
    if (this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const old = this.ws;
    this.ws = null;
    try {
      old?.close();
    } catch {
      // already closed
    }
    this.setStatus(false);
    this.retry = 0;
    this.lastSeen = Date.now();
    this.open();
  }

  /** A connection that has gone quiet (no ping, nothing) is dead even if the browser hasn't noticed. */
  private checkAlive() {
    if (this.closed || !this.connected) return;
    if (Date.now() - this.lastSeen > SILENCE_MS) this.reconnectNow();
  }

  private readonly onVisibility = () => {
    if (document.visibilityState !== "visible") {
      this.hiddenAt = Date.now();
      return;
    }
    const away = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (this.closed || away < AWAY_MS) return;
    // A phone freezes the page in the background: the socket may be dead, or alive with messages missed.
    if (!this.connected || Date.now() - this.lastSeen > SILENCE_MS) this.reconnectNow();
    else this.resync();
  };

  private resync() {
    for (const l of this.resyncListeners) l();
  }

  private setStatus(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.onStatus(connected);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` whenever live messages may have been missed (see the class comment). */
  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.ws?.close();
  }
}

/** Calls `onMessage` for every live message while the component is mounted. */
export function useLive(feed: LiveFeed, onMessage: Listener) {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  useEffect(() => feed.subscribe((m) => ref.current(m)), [feed]);
}

/** Calls `onResync` when live messages may have been missed: load what the page shows again. */
export function useResync(feed: LiveFeed, onResync: () => void) {
  const ref = useRef(onResync);
  ref.current = onResync;
  useEffect(() => feed.onResync(() => ref.current()), [feed]);
}

/** Loads data, and reloads it whenever a live message matches `when` or messages may have been missed. */
export function useLoad<T>(load: () => Promise<T>, feed: LiveFeed, when: (m: OutboundMessage) => boolean, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = () =>
    loadRef
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void reload();
  }, deps);
  useLive(feed, (m) => {
    if (when(m)) void reload();
  });
  useResync(feed, () => void reload());
  return { data, error, reload };
}
