import { int16ToFloat } from "@cc/voice";
import type { AsrUpdate, LocalAsrStream } from "@cc/voice/local";
import type { Context } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { tokenMatches } from "../auth";
import type { WsSessionAuth } from "./ws";

export interface VoiceListenDeps {
  adminToken: string;
  sessions?: WsSessionAuth;
  /** Opens a live recognition, or null when the self-hosted models aren't ready. */
  openStream: (onText: (update: AsrUpdate) => void) => LocalAsrStream | null;
  /** Longest a listen may last. */
  maxMs?: number;
}

/**
 * Live transcription over a WebSocket (`/ws/voice`), for Drive mode and dictation:
 * 1. client → `{"type":"hello","token"?,"latched"?}` (a same-origin session cookie also signs in);
 * 2. server → `{"type":"ready"}`, then the client streams 16 kHz mono 16-bit PCM as binary frames;
 * 3. server → `{"type":"partial","text"}` whenever the text changes (everything heard so far), and,
 *    unless latched, `{"type":"endOfTurn","text"}` once a pause follows speech;
 * 4. client → `{"type":"stop"}`; server → `{"type":"final","text"}` and closes.
 */
export function voiceListenHandler(upgradeWebSocket: UpgradeWebSocket<any>, deps: VoiceListenDeps) {
  return upgradeWebSocket(async (c: Context) => {
    const session = deps.sessions ? await deps.sessions.fromUpgrade(c).catch(() => null) : null;
    let stream: LocalAsrStream | null = null;
    let latched = false;
    let last = "";
    let done = false;
    let cap: ReturnType<typeof setTimeout> | undefined;

    const send = (ws: { send(d: string): void }, msg: object) => {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // closed
      }
    };
    const finish = async (ws: { send(d: string): void; close(code?: number, reason?: string): void }) => {
      if (done || !stream) return;
      done = true;
      clearTimeout(cap);
      const text = (await stream.finish().catch(() => "")) || last;
      send(ws, { type: "final", text });
      ws.close(1000, "done");
    };

    return {
      onMessage: async (evt, ws) => {
        const data = evt.data;
        if (typeof data !== "string") {
          if (!stream || done) return;
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
          if (!bytes?.byteLength) return;
          try {
            stream.accept(int16ToFloat(bytes));
          } catch (err) {
            console.error("[voice] listen", err);
            send(ws, { type: "error", message: "speech recognition failed" });
            ws.close(1011, "recognition failed");
          }
          return;
        }
        let msg: { type?: string; token?: string; latched?: boolean };
        try {
          msg = JSON.parse(data);
        } catch {
          return ws.close(4000, "invalid message");
        }
        if (!stream) {
          if (msg.type !== "hello") return ws.close(4001, "hello first");
          if (!session && !tokenMatches(msg.token, deps.adminToken)) return ws.close(4003, "bad token");
          const opened = (() => {
            try {
              return deps.openStream(({ text, endpoint }) => {
                if (done) return;
                if (text !== last) {
                  last = text;
                  send(ws, { type: "partial", text });
                }
                if (endpoint && !latched && text) send(ws, { type: "endOfTurn", text });
              });
            } catch (err) {
              console.error("[voice] listen open", err);
              return null;
            }
          })();
          if (!opened) {
            send(ws, { type: "error", message: "live transcription isn't ready on the server" });
            return ws.close(4004, "unavailable");
          }
          stream = opened;
          latched = msg.latched === true;
          cap = setTimeout(() => void finish(ws), deps.maxMs ?? 5 * 60_000 + 10_000);
          send(ws, { type: "ready" });
          return;
        }
        if (msg.type === "stop") await finish(ws);
      },
      onClose: () => {
        clearTimeout(cap);
        if (!done) stream?.close();
        done = true;
        stream = null;
      },
    };
  });
}
