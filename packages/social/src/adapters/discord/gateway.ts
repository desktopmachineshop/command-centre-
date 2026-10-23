import type { AdapterLogger } from "../../types";

/**
 * A minimal Discord Gateway client on Node's built-in WebSocket (Node 22).
 * Implements just what a bot that reads messages needs: Hello/heartbeat with
 * jitter, zombie detection (missed ACK), Identify, Resume via
 * `resume_gateway_url`, op 7 Reconnect, op 9 Invalid Session, close codes
 * that must not reconnect, and exponential backoff.
 * https://docs.discord.com/developers/events/gateway
 * https://docs.discord.com/developers/topics/opcodes-and-status-codes#gateway-close-event-codes
 */

/** The subset of the WHATWG WebSocket the client uses, so tests can inject a fake. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type GatewayConnector = (url: string) => GatewaySocket;

export const defaultConnector: GatewayConnector = (url) => new WebSocket(url) as unknown as GatewaySocket;

export const GATEWAY_VERSION = 10;
export const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg";

export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  /** Privileged: must be switched on under Bot -> Privileged Gateway Intents. */
  MESSAGE_CONTENT: 1 << 15,
} as const;
export const BOT_INTENTS = Intents.GUILDS | Intents.GUILD_MESSAGES | Intents.DIRECT_MESSAGES | Intents.MESSAGE_CONTENT;

const Op = { Dispatch: 0, Heartbeat: 1, Identify: 2, Resume: 6, Reconnect: 7, InvalidSession: 9, Hello: 10, HeartbeatAck: 11 } as const;

/** Close codes Discord marks "reconnect: false"; retrying would only fail again. */
const FATAL_CLOSE: Record<number, string> = {
  4004: "authentication failed (the bot token is wrong or was reset)",
  4010: "invalid shard",
  4011: "sharding required",
  4012: "invalid API version",
  4013: "invalid intents",
  4014: "disallowed intents (turn on the Message Content intent under Bot -> Privileged Gateway Intents)",
};
/** Close codes after which the session can't be resumed, so identify afresh. */
const NEW_SESSION_CLOSE = new Set([4007, 4009]);
/** Our own close code for a close we intend to resume after (1000/1001 would invalidate the session). */
const RESUMABLE_CLOSE = 4900;

export interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export interface GatewayOptions {
  token: string;
  intents?: number;
  /** Base gateway url (from GET /gateway/bot); the client appends `?v=10&encoding=json`. */
  url?: string;
  connect?: GatewayConnector;
  log: AdapterLogger;
  onDispatch(type: string, data: unknown): void;
  /** Called once the gateway can't continue (fatal close code). */
  onFatal?(err: Error): void;
  random?: () => number;
  /** Backoff cap. */
  maxBackoffMs?: number;
}

export class DiscordGateway {
  private socket: GatewaySocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private acked = true;
  private attempts = 0;
  private stopped = false;
  private readonly random: () => number;
  private readonly connectFn: GatewayConnector;

  constructor(private readonly opts: GatewayOptions) {
    this.random = opts.random ?? Math.random;
    this.connectFn = opts.connect ?? defaultConnector;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      try {
        socket.close(1000, "shutdown");
      } catch {
        /* already closed */
      }
    }
  }

  private open(): void {
    const resuming = this.canResume();
    const base = (resuming ? this.resumeUrl : this.opts.url) ?? DEFAULT_GATEWAY_URL;
    const url = `${base.replace(/\/+$/, "")}/?v=${GATEWAY_VERSION}&encoding=json`;
    let socket: GatewaySocket;
    try {
      socket = this.connectFn(url);
    } catch (err) {
      this.opts.log.error("[discord] gateway connect failed", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.acked = true;
    socket.onmessage = (ev) => this.onMessage(socket, ev.data);
    socket.onclose = (ev) => this.onClose(socket, ev.code, ev.reason);
    socket.onerror = () => {
      /* a close event always follows; handled there */
    };
    socket.onopen = null;
  }

  private canResume(): boolean {
    return this.sessionId !== null && this.seq !== null;
  }

  private send(socket: GatewaySocket, payload: GatewayPayload): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      this.opts.log.error("[discord] gateway send failed", err);
    }
  }

  private onMessage(socket: GatewaySocket, raw: unknown): void {
    if (socket !== this.socket) return;
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    switch (payload.op) {
      case Op.Hello: {
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(socket, interval);
        if (this.canResume()) {
          this.send(socket, { op: Op.Resume, d: { token: this.opts.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.send(socket, {
            op: Op.Identify,
            d: {
              token: this.opts.token,
              intents: this.opts.intents ?? BOT_INTENTS,
              properties: { os: process.platform, browser: "command-centre", device: "command-centre" },
            },
          });
        }
        break;
      }
      case Op.HeartbeatAck:
        this.acked = true;
        break;
      case Op.Heartbeat:
        this.send(socket, { op: Op.Heartbeat, d: this.seq });
        break;
      case Op.Reconnect:
        this.opts.log.info("[discord] gateway asked us to reconnect");
        this.reconnect(socket, true);
        break;
      case Op.InvalidSession: {
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = null;
          this.seq = null;
          this.resumeUrl = null;
        }
        this.opts.log.info(`[discord] invalid session (${resumable ? "resuming" : "identifying again"})`);
        // Discord asks for a random 1-5 s wait before identifying again.
        this.reconnect(socket, resumable, 1000 + Math.floor(this.random() * 4000));
        break;
      }
      case Op.Dispatch: {
        if (typeof payload.s === "number") this.seq = payload.s;
        const type = payload.t ?? "";
        if (type === "READY") {
          const d = payload.d as { session_id: string; resume_gateway_url?: string };
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url ?? null;
          this.attempts = 0;
        } else if (type === "RESUMED") {
          this.attempts = 0;
        }
        try {
          this.opts.onDispatch(type, payload.d);
        } catch (err) {
          this.opts.log.error(`[discord] ${type} handler failed`, err);
        }
        break;
      }
    }
  }

  private startHeartbeat(socket: GatewaySocket, interval: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const beat = () => {
      if (socket !== this.socket) return;
      if (!this.acked) {
        this.opts.log.info("[discord] heartbeat not acknowledged, reconnecting");
        this.reconnect(socket, true);
        return;
      }
      this.acked = false;
      this.send(socket, { op: Op.Heartbeat, d: this.seq });
      this.heartbeatTimer = setTimeout(beat, interval);
    };
    this.heartbeatTimer = setTimeout(beat, Math.floor(interval * this.random()));
  }

  /** Close the current socket ourselves and open a new one (resuming if we can). */
  private reconnect(socket: GatewaySocket, resume: boolean, delayMs?: number): void {
    if (!resume) {
      this.sessionId = null;
      this.seq = null;
    }
    this.clearTimers();
    detach(socket);
    this.socket = null;
    try {
      socket.close(RESUMABLE_CLOSE, "reconnect");
    } catch {
      /* already closed */
    }
    this.scheduleReconnect(delayMs);
  }

  private onClose(socket: GatewaySocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearTimers();
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      this.stopped = true;
      const err = new Error(`Discord gateway closed (${code}): ${fatal}`);
      this.opts.log.error(`[discord] ${err.message}; not reconnecting`);
      this.opts.onFatal?.(err);
      return;
    }
    if (NEW_SESSION_CLOSE.has(code)) {
      this.sessionId = null;
      this.seq = null;
      this.resumeUrl = null;
    }
    this.opts.log.info(`[discord] gateway closed (${code}${reason ? ` ${reason}` : ""}), reconnecting`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped) return;
    const cap = this.opts.maxBackoffMs ?? 60_000;
    const backoff = Math.min(cap, 1000 * 2 ** this.attempts) * (0.5 + this.random() / 2);
    this.attempts++;
    const wait = delayMs ?? (this.attempts === 1 ? 0 : backoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, wait);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }
}

function detach(socket: GatewaySocket): void {
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  socket.onopen = null;
}
