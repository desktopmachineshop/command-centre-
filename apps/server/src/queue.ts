import { PgBoss } from "pg-boss";

export interface TaskQueue {
  enqueue(taskId: string): Promise<void>;
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
  ) {
    this.boss = new PgBoss(connectionString);
    this.boss.on("error", (err) => console.error("[queue]", err));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    // Agent runs are long; give each one an hour before pg-boss considers it stuck.
    await this.boss.createQueue(QUEUE, { retryLimit: 1, retryDelay: 60, expireInSeconds: 3600 });
    this.started = true;
  }

  async enqueue(taskId: string): Promise<void> {
    await this.boss.send(QUEUE, { taskId });
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

  async enqueue(taskId: string): Promise<void> {
    if (!this.handler) throw new Error("No worker registered");
    this.pending.push(this.handler(taskId));
  }

  async work(handler: (taskId: string) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async drain(): Promise<void> {
    while (this.pending.length) await this.pending.shift();
  }

  async stop(): Promise<void> {}
}
