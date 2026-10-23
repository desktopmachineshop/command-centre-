import type { OutboundMessage } from "@cc/core";
import { useEffect, useRef, useState } from "react";
import type { Api } from "./api";

type Listener = (msg: OutboundMessage) => void;

/** One WebSocket per app session, reconnecting with backoff. */
export class LiveFeed {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private retry = 0;
  private closed = false;
  connected = false;
  onStatus: (connected: boolean) => void = () => {};

  constructor(private readonly api: Api) {
    this.open();
  }

  private open() {
    const ws = new WebSocket(this.api.wsUrl);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "client", token: this.api.token }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as OutboundMessage;
      if (msg.type === "welcome") {
        this.retry = 0;
        this.setStatus(true);
      }
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      this.setStatus(false);
      if (this.closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  private setStatus(connected: boolean) {
    this.connected = connected;
    this.onStatus(connected);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

/** Calls `onMessage` for every live message while the component is mounted. */
export function useLive(feed: LiveFeed, onMessage: Listener) {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  useEffect(() => feed.subscribe((m) => ref.current(m)), [feed]);
}

/** Loads data, and reloads it whenever a live message matches `when`. */
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
  return { data, error, reload };
}
