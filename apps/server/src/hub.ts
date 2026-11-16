import type { OutboundMessage } from "@cc/core";

/** Anything we can push a frame to (a WebSocket, or a test double). */
export interface Peer {
  send(data: string): void;
}

/** A client that hasn't reported its presence for this long isn't counted as watching. */
const PRESENCE_MS = 70_000;

/**
 * Fan-out of live updates: every connected client gets every message;
 * worker nodes only get messages addressed to them.
 */
export class Hub {
  /**
   * App clients: whether each says its app is on screen, and when it last said so. The app answers
   * every ping with its presence, so a phone that has frozen the page (or lost its connection
   * without closing it) stops counting within a minute or so.
   */
  private readonly clients = new Map<Peer, { visible: boolean; seenAt: number }>();
  private readonly workers = new Map<string, Peer>();

  addClient(peer: Peer): void {
    this.clients.set(peer, { visible: true, seenAt: Date.now() });
  }

  /** A client reporting that its app came on screen or left it (`client.presence`). */
  setVisible(peer: Peer, visible: boolean): void {
    const client = this.clients.get(peer);
    if (!client) return;
    client.visible = visible;
    client.seenAt = Date.now();
  }

  /** Whether the app is on screen somewhere, so Dave can see what arrives. */
  watching(): boolean {
    const fresh = Date.now() - PRESENCE_MS;
    for (const client of this.clients.values()) if (client.visible && client.seenAt >= fresh) return true;
    return false;
  }

  removeClient(peer: Peer): void {
    this.clients.delete(peer);
  }

  addWorker(nodeId: string, peer: Peer): void {
    this.workers.set(nodeId, peer);
  }

  /** Removes the worker only if `peer` is still its current connection. */
  removeWorker(nodeId: string, peer: Peer): boolean {
    if (this.workers.get(nodeId) !== peer) return false;
    this.workers.delete(nodeId);
    return true;
  }

  /**
   * Pings every app client on an interval. Proxies (Railway's among them) close a WebSocket that
   * has been quiet for a couple of minutes; without this the app's live feed dropped every two
   * minutes and anything sent in the gap was lost. Returns the function that stops it.
   */
  startHeartbeat(intervalMs = 25_000): () => void {
    const timer = setInterval(() => this.broadcast({ type: "ping" }), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  broadcast(message: OutboundMessage): void {
    const frame = JSON.stringify(message);
    for (const peer of this.clients.keys()) safeSend(peer, frame);
  }

  sendToWorker(nodeId: string, message: OutboundMessage): boolean {
    const peer = this.workers.get(nodeId);
    if (!peer) return false;
    return safeSend(peer, JSON.stringify(message));
  }
}

function safeSend(peer: Peer, frame: string): boolean {
  try {
    peer.send(frame);
    return true;
  } catch {
    return false;
  }
}
