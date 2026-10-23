import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ClaudeCodeRunner } from "@cc/agent-runtime";
import { z } from "zod";
import { defineHandler, JobError } from "./registry";

export const ClaudePayload = z.object({
  prompt: z.string().min(1).max(100_000),
  /** Working directory; must be inside one of the worker's allowed directories. Defaults to the job dir. */
  cwd: z.string().optional(),
  maxTurns: z.number().int().positive().max(200).optional(),
});

function isInside(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Runs headless Claude Code on this machine, on whatever login it has. Claude
 * Code's own permission rules still apply; the server only supplies the prompt.
 */
export function claudeHandler(options: { bin: string; allowedDirs: string[]; env?: NodeJS.ProcessEnv }) {
  const runner = new ClaudeCodeRunner({ name: "claude-local", bin: options.bin, env: options.env });
  return defineHandler({
    kind: "claude.local",
    payload: ClaudePayload,
    async run(payload, ctx) {
      const cwd = payload.cwd ? resolve(payload.cwd) : ctx.dir;
      if (payload.cwd && !options.allowedDirs.some((root) => isInside(cwd, root))) {
        throw new JobError(`cwd ${cwd} is outside the allowed directories (${options.allowedDirs.join(", ")})`);
      }
      if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new JobError(`cwd ${cwd} is not a directory`);

      let steps = 0;
      const result = await runner.run({ prompt: payload.prompt, cwd, maxTurns: payload.maxTurns, signal: ctx.signal }, (m) => {
        steps++;
        const text = m.type === "text" ? m.text : m.type === "tool_use" ? `tool: ${m.name}` : undefined;
        ctx.progress(Math.min(0.95, steps * 0.05), text?.slice(0, 200));
      });
      if (result.status === "failed") throw new JobError(result.error ?? "Claude Code run failed");
      return { result: result.result, sessionId: result.sessionId, costUsd: result.costUsd };
    },
  });
}
