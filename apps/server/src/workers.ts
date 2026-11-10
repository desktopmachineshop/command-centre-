import { type Capability, type InboundMessage, type Job, type NodeSetup, REDDIT_BROWSER_JOB, roleStatus, SETUP_ROLES, type SetupRoleId } from "@cc/core";
import type { Store } from "./db/store";
import type { Hub, Peer } from "./hub";

/** How a job someone is waiting for (`run`) ended. */
export type JobOutcome =
  | { kind: "settled"; job: Job }
  /** No computer took it within `pickupMs`; it was cancelled, so it never ran. */
  | { kind: "not-picked-up" }
  /** It was running when `timeoutMs` ran out; it may still finish (and nobody hears of it). */
  | { kind: "timed-out" }
  /** A run-at-most-once job whose computer dropped mid-job: cancelled, not requeued, outcome unknown. */
  | { kind: "dropped" };

/**
 * Desktop worker nodes: registration, heartbeats and capability-matched job
 * dispatch. A node runs one job at a time; its jobs are requeued if it drops
 * (except a run-at-most-once job, see `run`).
 */
export class WorkerService {
  private readonly online = new Map<string, Capability[]>();
  private readonly settledListeners: ((job: Job) => Promise<void> | void)[] = [];
  /** Jobs someone awaits with `run`, by id. */
  private readonly waiters = new Map<string, (outcome: JobOutcome) => void>();
  /** Jobs that must not run twice (a Reddit post): cancelled rather than requeued when their computer drops. */
  private readonly atMostOnce = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
  ) {}

  async connect(node: { id: string; name: string; capabilities: Capability[]; setup?: NodeSetup }, peer: Peer): Promise<void> {
    // Save the node before it can be dispatched to: a job claimed for a node with no row fails jobs_node_id_fkey.
    const saved = await this.store.upsertNode(node);
    this.hub.addWorker(node.id, peer);
    this.online.set(node.id, node.capabilities);
    this.hub.broadcast({ type: "node.updated", node: saved });
    await this.dispatch();
  }

  async disconnect(nodeId: string, peer: Peer): Promise<void> {
    if (!this.hub.removeWorker(nodeId, peer)) return; // a newer connection replaced this one
    this.online.delete(nodeId);
    const node = await this.store.setNodeOffline(nodeId);
    if (node) this.hub.broadcast({ type: "node.updated", node });
    for (const requeued of await this.store.requeueJobsForNode(nodeId)) {
      // It may already have posted before the connection dropped: never hand it to another run.
      const job = this.atMostOnce.has(requeued.id) ? ((await this.store.cancelQueuedJob(requeued.id)) ?? requeued) : requeued;
      this.hub.broadcast({ type: "job.updated", job });
      if (job.status === "cancelled") {
        this.atMostOnce.delete(job.id);
        this.waiters.get(job.id)?.({ kind: "dropped" });
      }
    }
    await this.dispatch();
  }

  async handle(nodeId: string, message: InboundMessage): Promise<void> {
    switch (message.type) {
      case "worker.heartbeat":
        await this.store.touchNode(nodeId);
        return;
      case "worker.capabilities": {
        // It installed something (a setup.install job): it may take jobs it couldn't before.
        const node = await this.store.updateNodeCapabilities(nodeId, message.capabilities, message.setup);
        if (this.online.has(nodeId)) this.online.set(nodeId, message.capabilities);
        if (node) this.hub.broadcast({ type: "node.updated", node });
        await this.dispatch();
        return;
      }
      case "job.progress": {
        const job = await this.store.updateJob(message.jobId, nodeId, { status: "running", progress: message.progress });
        if (job) this.hub.broadcast({ type: "job.updated", job });
        return;
      }
      case "job.complete":
      case "job.fail": {
        const job = await this.store.updateJob(
          message.jobId,
          nodeId,
          message.type === "job.complete"
            ? { status: "succeeded", progress: 1, result: message.result }
            : { status: "failed", result: { error: message.error } },
        );
        if (job) this.hub.broadcast({ type: "job.updated", job });
        await this.dispatch();
        if (job) {
          this.atMostOnce.delete(job.id);
          this.waiters.get(job.id)?.({ kind: "settled", job });
          await this.settled(job);
        }
        return;
      }
    }
  }

  async submit(job: { kind: string; requires: Capability[]; payload: Record<string, unknown>; targetNodeId?: string | null }, beforeDispatch?: (job: Job) => void) {
    const created = await this.store.insertJob(job);
    beforeDispatch?.(created);
    this.hub.broadcast({ type: "job.updated", job: created });
    await this.dispatch();
    return created;
  }

  /** Whether a connected computer (that one, if given) has every capability in `requires`. */
  capableOnline(requires: Capability[], nodeId?: string | null): boolean {
    for (const [id, capabilities] of this.online) {
      if (nodeId && id !== nodeId) continue;
      if (requires.every((c) => capabilities.includes(c))) return true;
    }
    return false;
  }

  /**
   * Submits a job and waits for it to finish, for a caller that needs the result now (a Reddit
   * post from the PC). A job no computer takes within `pickupMs` is cancelled (it never ran); one
   * still running at `timeoutMs` is left to finish unheard. `once`: if its computer drops
   * mid-job it is cancelled, not run again elsewhere.
   */
  async run(
    job: { kind: string; requires: Capability[]; payload: Record<string, unknown>; targetNodeId?: string | null },
    options: { pickupMs: number; timeoutMs: number; once?: boolean; signal?: AbortSignal },
  ): Promise<JobOutcome> {
    let id = "";
    let resolve!: (o: JobOutcome) => void;
    const outcome = new Promise<JobOutcome>((r) => (resolve = r));
    const timers: NodeJS.Timeout[] = [];
    const created = await this.submit(job, (j) => {
      id = j.id;
      if (options.once) this.atMostOnce.add(id);
      this.waiters.set(id, resolve);
    });
    timers.push(
      setTimeout(async () => {
        const cancelled = await this.store.cancelQueuedJob(id).catch(() => null);
        if (cancelled) {
          this.hub.broadcast({ type: "job.updated", job: cancelled });
          resolve({ kind: "not-picked-up" });
        }
      }, options.pickupMs),
      setTimeout(() => resolve({ kind: "timed-out" }), options.timeoutMs),
    );
    const abort = () => resolve({ kind: "timed-out" });
    options.signal?.addEventListener("abort", abort, { once: true });
    const result = await outcome;
    for (const t of timers) clearTimeout(t);
    options.signal?.removeEventListener("abort", abort);
    this.waiters.delete(created.id);
    // Still running: it stays run-at-most-once until it settles or its computer drops.
    if (result.kind !== "timed-out") this.atMostOnce.delete(created.id);
    return result;
  }

  /**
   * One click on the Devices page: installs what a role is missing on one computer, as a
   * `setup.install` job only that computer takes. The job names components from the catalog in
   * @cc/core; the worker maps them to its own package list and ignores anything else.
   */
  async installRole(nodeId: string, roleId: SetupRoleId): Promise<Job> {
    const role = SETUP_ROLES.find((r) => r.id === roleId)!;
    const node = await this.store.getNode(nodeId);
    if (!node) throw new SetupError("No such computer.", 404);
    if (!node.setup) throw new SetupError(`${node.name} runs an older desktop app that can't install software. Update it from the tray menu first.`, 409);
    if (!node.setup.installer) throw new SetupError(`${node.name} can't install software by itself (it needs Windows with winget, the App Installer from the Microsoft Store).`, 409);
    const { installable } = roleStatus(role, node);
    if (installable.length === 0) throw new SetupError(`${node.name} has everything ${role.label} can install from here.`, 409);
    const busy = (await this.store.listJobs({ limit: 200 })).find(
      (j) => j.kind === "setup.install" && j.targetNodeId === nodeId && (j.status === "queued" || j.status === "assigned" || j.status === "running"),
    );
    if (busy) throw new SetupError(`${node.name} is already installing. Wait for it to finish.`, 409);
    return this.submit({ kind: "setup.install", requires: [], targetNodeId: nodeId, payload: { role: role.id, components: installable } });
  }

  /**
   * Sign in to Reddit on this PC, from the Devices page: a `social.reddit.browser` login job for
   * that computer alone, which opens its Reddit window at the login page and waits (5 minutes)
   * for Dave to sign in there himself. Nothing he types passes through here.
   */
  async redditLogin(nodeId: string): Promise<Job> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new SetupError("No such computer.", 404);
    if (!this.online.has(nodeId)) throw new SetupError(`${node.name} is offline. Open the desktop app on it, then try again.`, 409);
    if (!this.capableOnline(["browser"], nodeId)) {
      throw new SetupError(`${node.name} can't drive a browser yet (it needs Chrome or Edge and the Media production setup). Install Media production on it first.`, 409);
    }
    const busy = (await this.store.listJobs({ limit: 200 })).find(
      (j) => j.kind === REDDIT_BROWSER_JOB && j.payload.op === "login" && j.targetNodeId === nodeId && (j.status === "queued" || j.status === "assigned" || j.status === "running"),
    );
    if (busy) throw new SetupError(`${node.name} is already waiting for you to sign in to Reddit in its window.`, 409);
    return this.submit({ kind: REDDIT_BROWSER_JOB, requires: ["browser"], targetNodeId: nodeId, payload: { op: "login", timeoutSec: 300 } });
  }

  /**
   * Update now, from the Devices page: tells that computer's worker to have its desktop app
   * install the newest signed build (the same check as the tray menu's Check for updates).
   * The worker waits for a running job to finish first, since updating restarts it.
   */
  async requestUpdate(nodeId: string): Promise<void> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new SetupError("No such computer.", 404);
    if (!node.setup?.remoteUpdate) {
      throw new SetupError(`${node.name}'s desktop app can't be updated from here yet. Choose Check for updates in its tray menu once; after that, Update works from this page.`, 409);
    }
    if (!this.online.has(nodeId) || !this.hub.sendToWorker(nodeId, { type: "app.update" })) {
      throw new SetupError(`${node.name} is offline. Open the desktop app on it, then try again.`, 409);
    }
  }

  /**
   * Cancels a job still waiting for a computer. Running jobs can't be cancelled
   * (the worker would need to stop it). The video chain simply ends: no next
   * stage, no notification.
   */
  async cancel(jobId: string): Promise<Job | null> {
    const job = await this.store.cancelQueuedJob(jobId);
    if (job) this.hub.broadcast({ type: "job.updated", job });
    return job;
  }

  /** Called when a job succeeds or fails (e.g. to chain the next video stage). */
  onJobSettled(listener: (job: Job) => Promise<void> | void): void {
    this.settledListeners.push(listener);
  }

  private async settled(job: Job): Promise<void> {
    for (const listener of this.settledListeners) {
      try {
        await listener(job);
      } catch (err) {
        console.error(`[workers] job ${job.id} (${job.kind}) settle hook failed: ${(err as Error).message}`);
      }
    }
  }

  /** Hands queued jobs to idle online nodes that have every required capability. */
  async dispatch(): Promise<void> {
    for (const [nodeId, capabilities] of this.online) {
      const job = await this.store.claimJobForNode(nodeId, capabilities);
      if (!job) continue;
      this.hub.broadcast({ type: "job.updated", job });
      if (!this.hub.sendToWorker(nodeId, { type: "job.assign", job })) {
        for (const j of await this.store.requeueJobsForNode(nodeId)) this.hub.broadcast({ type: "job.updated", job: j });
      }
    }
  }
}

export class SetupError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}
