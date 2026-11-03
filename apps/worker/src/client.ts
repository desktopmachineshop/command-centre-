import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Capability, type InboundMessage, type Job, type NodeSetup, OutboundMessage } from "@cc/core";
import type { HandlerRegistry } from "./handlers/registry";
import { createStorageUploader, type StorageUploader } from "./storage";

export type WorkerState = "connecting" | "connected" | "disconnected" | "stopped";

export interface WorkerStatus {
  state: WorkerState;
  /** The job being run, if any. */
  job: { id: string; kind: string; progress: number } | null;
  error?: string;
}

export interface WorkerClientOptions {
  wsUrl: string;
  token: string;
  node: { id: string; name: string; capabilities: Capability[]; setup?: NodeSetup };
  registry: HandlerRegistry;
  /**
   * Detects capabilities and setup again (and rebuilds the handlers for them). Jobs call it as
   * ctx.refresh after installing software; the server then hears about the change.
   */
  redetect?: () => Promise<{ capabilities: Capability[]; setup?: NodeSetup; registry?: HandlerRegistry }>;
  workDir: string;
  heartbeatMs?: number;
  /** Reconnect backoff: doubles from `minMs` up to `maxMs`, with jitter. */
  backoff?: { minMs: number; maxMs: number };
  /** Minimum gap between progress frames for one job. */
  progressIntervalMs?: number;
  onStatus?: (status: WorkerStatus) => void;
  log?: (line: string) => void;
  /** Upload helper handed to jobs as ctx.storage; defaults to one for this server and token. */
  storage?: StorageUploader;
}

/** Delay before reconnect attempt `attempt` (0-based): exponential, with "equal jitter". */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random = Math.random): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * The worker's connection to the server: says hello, heartbeats, reconnects
 * with backoff, and runs assigned jobs one at a time through the registry.
 * A job is aborted if the connection drops, since the server requeues it.
 */
export class WorkerClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private current: { job: Job; abort: AbortController; progress: number } | null = null;
  private status: WorkerStatus = { state: "disconnected", job: null };

  private readonly storage: StorageUploader;
  private node: WorkerClientOptions["node"];
  private registry: HandlerRegistry;

  constructor(private readonly options: WorkerClientOptions) {
    this.storage = options.storage ?? createStorageUploader({ serverUrl: options.wsUrl, token: options.token });
    this.node = { ...options.node };
    this.registry = options.registry;
  }

  /** What this computer currently offers (it changes after a setup.install job). */
  get capabilities(): Capability[] {
    return this.node.capabilities;
  }

  /** Re-detects capabilities and setup, and tells the server if connected (or in the next hello). */
  async refresh(): Promise<void> {
    if (!this.options.redetect) return;
    const next = await this.options.redetect();
    this.node = { ...this.node, capabilities: next.capabilities, ...(next.setup ? { setup: next.setup } : {}) };
    if (next.registry) this.registry = next.registry;
    this.log(`now offering [${this.node.capabilities.join(", ") || "no capabilities"}]`);
    this.send({ type: "worker.capabilities", capabilities: this.node.capabilities, setup: this.node.setup });
  }

  get state(): WorkerStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.current?.abort.abort();
    this.ws?.close(1000, "worker stopping");
    this.ws = null;
    this.setStatus({ state: "stopped" });
  }

  private log(line: string) {
    (this.options.log ?? console.log)(`[worker] ${line}`);
  }

  private setStatus(patch: Partial<WorkerStatus>) {
    const c = this.current;
    this.status = { ...this.status, error: undefined, ...patch, job: c ? { id: c.job.id, kind: c.job.kind, progress: c.progress } : null };
    this.options.onStatus?.(this.status);
  }

  private send(message: InboundMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private connect() {
    this.setStatus({ state: "connecting" });
    const ws = new WebSocket(this.options.wsUrl);
    this.ws = ws;

    // Node's WebSocket may fire only "error" when a connection attempt fails, so both end up here.
    let down = false;
    const onDown = (reason: string) => {
      if (down || this.ws !== ws) return;
      down = true;
      clearTimeout(connectTimer);
      this.ws = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.current) {
        this.log(`connection lost; aborting job ${this.current.job.id} (the server requeues it)`);
        this.current.abort.abort();
        this.current = null;
      }
      if (this.stopped) return;
      const delay = backoffDelay(this.attempt++, this.options.backoff?.minMs ?? 1000, this.options.backoff?.maxMs ?? 60_000);
      this.log(`disconnected (${reason}); reconnecting in ${delay}ms`);
      this.setStatus({ state: "disconnected", error: reason });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    const connectTimer = setTimeout(() => {
      onDown("connect timeout");
      ws.close();
    }, 15_000);

    ws.addEventListener("open", () => {
      clearTimeout(connectTimer);
      this.send({ type: "hello", role: "worker", token: this.options.token, node: this.node });
    });
    ws.addEventListener("message", (evt) => {
      let msg: OutboundMessage;
      try {
        msg = OutboundMessage.parse(JSON.parse(String(evt.data)));
      } catch {
        return; // a message type this worker doesn't know yet
      }
      this.onMessage(msg);
    });
    ws.addEventListener("close", (evt) => onDown(evt.reason || `code ${evt.code}`));
    ws.addEventListener("error", (evt) => onDown((evt as Event & { message?: string }).message || "connection error"));
  }

  private onMessage(msg: OutboundMessage) {
    switch (msg.type) {
      case "welcome":
        this.attempt = 0;
        this.log(`connected as ${this.node.name} [${this.node.capabilities.join(", ") || "no capabilities"}]`);
        this.setStatus({ state: "connected" });
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.send({ type: "worker.heartbeat" }), this.options.heartbeatMs ?? 20_000);
        return;
      case "error":
        this.log(`server error: ${msg.message}`);
        return;
      case "job.assign":
        void this.runJob(msg.job);
        return;
    }
  }

  private async runJob(job: Job) {
    if (this.current) {
      this.send({ type: "job.fail", jobId: job.id, error: "worker is busy with another job" });
      return;
    }
    const abort = new AbortController();
    const run = { job, abort, progress: 0 };
    this.current = run;
    this.setStatus({});
    this.log(`job ${job.id} (${job.kind}) started`);

    const interval = this.options.progressIntervalMs ?? 250;
    let lastSent = 0;
    let pending: NodeJS.Timeout | null = null;
    const flush = (message?: string) => {
      pending = null;
      lastSent = Date.now();
      if (this.current === run) this.send({ type: "job.progress", jobId: job.id, progress: run.progress, message });
    };

    let outcome: InboundMessage;
    try {
      const dir = join(this.options.workDir, "jobs", job.id);
      mkdirSync(dir, { recursive: true });
      const result = await this.registry.run({
        job,
        dir,
        signal: abort.signal,
        storage: this.storage,
        refresh: () => this.refresh(),
        progress: (progress, message) => {
          run.progress = Math.max(0, Math.min(1, progress));
          this.setStatus({});
          if (pending) clearTimeout(pending);
          const wait = lastSent + interval - Date.now();
          if (wait <= 0) flush(message);
          else pending = setTimeout(() => flush(message), wait);
        },
      });
      outcome = { type: "job.complete", jobId: job.id, result: result ?? null };
      this.log(`job ${job.id} succeeded`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome = { type: "job.fail", jobId: job.id, error };
      this.log(`job ${job.id} failed: ${error}`);
    }
    if (pending) clearTimeout(pending);
    if (this.current !== run) return; // aborted by a disconnect; the server has already requeued it
    this.current = null;
    this.send(outcome);
    this.setStatus({});
  }
}
