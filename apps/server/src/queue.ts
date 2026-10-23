import { PgBoss } from "pg-boss";

export interface EnqueueOptions {
  /** Wait this long before the task becomes runnable. */
  delaySeconds?: number;
}

export interface TaskQueue {
  enqueue(taskId: string, options?: EnqueueOptions): Promise<void>;
  /** Starts consuming; `handler` runs one task. */
  work(handler: (taskId: string) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

const QUEUE = "agent-task";

/** Durable queue on Postgres; survives restarts and supports multiple replicas. */
export class PgBossTaskQueue implements TaskQueue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(
    connectionString: string,
    private readonly concurrency: number,
    /**
     * How long a job may stay active before pg-boss redelivers it. Keep it above
     * the stale-run window (agent timeout + 300s), so a redelivery only finds
     * runs that really died. Capped at pg-boss's 24 hours.
     */
    private readonly expireInSeconds = 3600,
  ) {
    this.boss = new PgBoss(connectionString);
    this.boss.on("error", (err) => console.error("[queue]", err));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    const expireInSeconds = Math.min(Math.ceil(this.expireInSeconds), 24 * 3600);
    await this.boss.createQueue(QUEUE, { retryLimit: 1, retryDelay: 60, expireInSeconds });
    // createQueue leaves an existing queue as it was; bring its expiry in line with the current timeout.
    await this.boss.updateQueue(QUEUE, { expireInSeconds });
    this.started = true;
  }

  async enqueue(taskId: string, options: EnqueueOptions = {}): Promise<void> {
    const startAfter = options.delaySeconds ? Math.ceil(options.delaySeconds) : undefined;
    await this.boss.send(QUEUE, { taskId }, startAfter ? { startAfter } : {});
  }

  async work(handler: (taskId: string) => Promise<void>): Promise<void> {
    await this.boss.work<{ taskId: string }>(QUEUE, { localConcurrency: this.concurrency, batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await handler(job.data.taskId);
    });
  }

  async stop(): Promise<void> {
    if (this.started) await this.boss.stop({ graceful: true });
  }
}

/** Runs tasks in-process as soon as they are enqueued. For tests. */
export class InlineTaskQueue implements TaskQueue {
  private handler?: (taskId: string) => Promise<void>;
  readonly pending: Promise<void>[] = [];

  async enqueue(taskId: string, options: EnqueueOptions = {}): Promise<void> {
    const handler = this.handler;
    if (!handler) throw new Error("No worker registered");
    const ms = (options.delaySeconds ?? 0) * 1000;
    this.pending.push(ms ? new Promise((r) => setTimeout(r, ms)).then(() => handler(taskId)) : handler(taskId));
  }

  async work(handler: (taskId: string) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async drain(): Promise<void> {
    while (this.pending.length) await this.pending.shift();
  }

  async stop(): Promise<void> {}
}
