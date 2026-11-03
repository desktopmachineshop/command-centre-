import type { Job } from "@cc/core";
import { z } from "zod";
import type { StorageUploader } from "../storage";

export interface JobContext {
  job: Job;
  /** Scratch directory for this job, created before the handler runs. */
  dir: string;
  /** Reports progress (0..1). Calls are throttled by the client. */
  progress(progress: number, message?: string): void;
  /** Aborted when the worker shuts down. */
  signal: AbortSignal;
  /** Uploads an output file to Command Centre storage; see ../storage.ts. */
  storage?: StorageUploader;
  /** Re-detects what this computer can do and tells the server (after installing something). */
  refresh?: () => Promise<void>;
}

/**
 * A job kind this worker knows how to run. The payload is validated against
 * `payload` before `run` sees it; nothing from the server runs otherwise.
 */
export interface JobHandler<S extends z.ZodType = z.ZodType> {
  kind: string;
  payload: S;
  run(payload: z.infer<S>, ctx: JobContext): Promise<unknown>;
}

export function defineHandler<S extends z.ZodType>(handler: JobHandler<S>): JobHandler<S> {
  return handler;
}

export class JobError extends Error {}

export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(handler: JobHandler<any>): this {
    this.handlers.set(handler.kind, handler);
    return this;
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }

  /** Validates the job and runs its handler. Throws a JobError for unknown kinds or bad payloads. */
  async run(ctx: JobContext): Promise<unknown> {
    const handler = this.handlers.get(ctx.job.kind);
    if (!handler) throw new JobError(`Unknown job kind "${ctx.job.kind}" (this worker runs: ${this.kinds().join(", ")})`);
    const parsed = handler.payload.safeParse(ctx.job.payload);
    if (!parsed.success) throw new JobError(`Invalid ${ctx.job.kind} payload: ${z.prettifyError(parsed.error)}`);
    return handler.run(parsed.data, ctx);
  }
}
