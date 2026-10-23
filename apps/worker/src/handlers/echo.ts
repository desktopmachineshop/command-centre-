import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { defineHandler } from "./registry";

/** Test job: reports a couple of progress steps and returns its payload. */
export const echoHandler = defineHandler({
  kind: "echo",
  payload: z.object({ message: z.string().optional(), steps: z.number().int().min(0).max(100).default(2), delayMs: z.number().int().min(0).max(10_000).default(10) }),
  async run(payload, ctx) {
    for (let i = 1; i <= payload.steps; i++) {
      await sleep(payload.delayMs, undefined, { signal: ctx.signal });
      ctx.progress(i / (payload.steps + 1), `step ${i}`);
    }
    return { echo: payload.message ?? null };
  },
});
