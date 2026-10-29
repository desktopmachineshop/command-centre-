import type { Capability, InboundMessage, Job } from "@cc/core";
import type { Store } from "./db/store";
import type { Hub, Peer } from "./hub";

/**
 * Desktop worker nodes: registration, heartbeats and capability-matched job
 * dispatch. A node runs one job at a time; its jobs are requeued if it drops.
 */
export class WorkerService {
  private readonly online = new Map<string, Capability[]>();
  private readonly settledListeners: ((job: Job) => Promise<void> | void)[] = [];

  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
  ) {}

  async connect(node: { id: string; name: string; capabilities: Capability[] }, peer: Peer): Promise<void> {
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
    for (const job of await this.store.requeueJobsForNode(nodeId)) this.hub.broadcast({ type: "job.updated", job });
    await this.dispatch();
  }

  async handle(nodeId: string, message: InboundMessage): Promise<void> {
    switch (message.type) {
      case "worker.heartbeat":
        await this.store.touchNode(nodeId);
        return;
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
        if (job) await this.settled(job);
        return;
      }
    }
  }

  async submit(job: { kind: string; requires: Capability[]; payload: Record<string, unknown> }) {
    const created = await this.store.insertJob(job);
    this.hub.broadcast({ type: "job.updated", job: created });
    await this.dispatch();
    return created;
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
