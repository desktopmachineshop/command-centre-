import { parseInbound } from "@cc/core";
import type { Context } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { tokenMatches } from "../auth";
import type { Hub, Peer } from "../hub";
import type { WorkerService } from "../workers";

/** Cookie sign-in for browser clients (src/accounts): resolves the upgrade request's session. */
export interface WsSessionAuth {
  fromUpgrade: (c: Context) => Promise<{ sessionId: string } | null>;
  /** Called with session ids as they are signed out, so their sockets close. */
  onRevoke: (listener: (sessionIds: string[]) => void) => () => void;
}

/**
 * One endpoint for both clients and worker nodes. The first frame must be a
 * `hello` with a token (browsers cannot set headers on WebSockets). A browser
 * client whose upgrade request carried a valid same-origin session cookie is
 * accepted without a token; workers always need WORKER_TOKEN.
 */
export function wsHandler(
  upgradeWebSocket: UpgradeWebSocket<any>,
  deps: { hub: Hub; workers: WorkerService; adminToken: string; workerToken: string; sessions?: WsSessionAuth },
) {
  return upgradeWebSocket(async (c) => {
    const session = deps.sessions ? await deps.sessions.fromUpgrade(c).catch(() => null) : null;
    let stopWatching: (() => void) | null = null;
    let role: "client" | "worker" | null = null;
    let nodeId: string | null = null;
    let peer: Peer | null = null;

    return {
      onMessage: async (evt, ws) => {
        const msg = parseInbound(typeof evt.data === "string" ? evt.data : evt.data.toString());
        if (!msg) return ws.send(JSON.stringify({ type: "error", message: "invalid message" }));

        if (!role) {
          if (msg.type !== "hello") return ws.close(4001, "hello first");
          const token = msg.role === "worker" ? deps.workerToken : deps.adminToken;
          const viaCookie = msg.role === "client" && session !== null;
          if (!viaCookie && !tokenMatches(msg.token, token)) return ws.close(4003, "bad token");
          if (viaCookie && deps.sessions) {
            stopWatching = deps.sessions.onRevoke((ids) => {
              if (ids.includes(session.sessionId)) ws.close(4003, "signed out");
            });
          }
          peer = { send: (d) => ws.send(d) };
          if (msg.role === "worker") {
            if (!msg.node) return ws.close(4002, "worker hello needs node");
            role = "worker";
            nodeId = msg.node.id;
            ws.send(JSON.stringify({ type: "welcome", role }));
            await deps.workers.connect(msg.node, peer);
          } else {
            role = "client";
            deps.hub.addClient(peer);
            ws.send(JSON.stringify({ type: "welcome", role }));
          }
          return;
        }

        if (role === "worker" && nodeId) await deps.workers.handle(nodeId, msg).catch((err) => console.error("[ws]", err));
      },
      onClose: () => {
        stopWatching?.();
        if (!peer) return;
        if (role === "client") deps.hub.removeClient(peer);
        if (role === "worker" && nodeId) deps.workers.disconnect(nodeId, peer).catch((err) => console.error("[ws]", err));
      },
    };
  });
}
