import type { OutboundMessage } from "@cc/core";

/** Anything we can push a frame to (a WebSocket, or a test double). */
export interface Peer {
  send(data: string): void;
}

/**
 * Fan-out of live updates: every connected client gets every message;
 * worker nodes only get messages addressed to them.
 */
export class Hub {
  private readonly clients = new Set<Peer>();
  private readonly workers = new Map<string, Peer>();

  addClient(peer: Peer): void {
    this.clients.add(peer);
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

  broadcast(message: OutboundMessage): void {
    const frame = JSON.stringify(message);
    for (const peer of this.clients) safeSend(peer, frame);
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
