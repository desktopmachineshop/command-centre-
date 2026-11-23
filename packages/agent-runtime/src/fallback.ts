import type { AgentRunner, AgentRunRequest, AgentRunResult, OnAgentMessage } from "./runner";

const LIMIT_PATTERN = /usage limit|rate limit|limit reached|quota|overloaded/i;
/** The runner couldn't take the run at all: not signed in, key refused, CLI missing, not suited to the task. */
const UNAVAILABLE_PATTERN = /isn't connected|isn't available|can't be used|Failed to start/i;

/** A run that failed on a usage or rate limit (the next runner may still have room). */
export function isUsageLimit(r: AgentRunResult): boolean {
  return r.status === "failed" && LIMIT_PATTERN.test(r.error ?? "");
}

/** A run its runner couldn't take: no account connected, the key refused, the CLI missing, or a task it can't do. */
export function isUnavailable(r: AgentRunResult): boolean {
  return r.status === "failed" && UNAVAILABLE_PATTERN.test(r.error ?? "");
}

/** What the primary did before it failed, for deciding whether a retry elsewhere is safe. */
export interface FallbackInfo {
  /** The primary called at least one tool, so it may already have changed something. */
  usedTools: boolean;
}

export type ShouldFallback = (r: AgentRunResult, info: FallbackInfo) => boolean;

/**
 * The fallback rule for a route of agents: move on at a usage limit, when the agent isn't
 * available, or when the run failed before it touched any tool (nothing done, so nothing is
 * done twice). A failure after tool calls stays failed: the next agent could repeat them.
 */
export const nextAgent: ShouldFallback = (r, { usedTools }) => isUsageLimit(r) || isUnavailable(r) || (r.status === "failed" && !usedTools && r.error !== "Aborted");

/**
 * Runs `primary`; if it fails in a way `shouldFallback` accepts (by default a usage limit),
 * re-runs on `fallback` (e.g. subscription first, then API key). Never after the run was stopped.
 */
export class FallbackRunner implements AgentRunner {
  constructor(
    readonly name: string,
    private readonly primary: AgentRunner,
    private readonly fallback: AgentRunner,
    private readonly shouldFallback: ShouldFallback = isUsageLimit,
  ) {}

  async run(request: AgentRunRequest, onMessage?: OnAgentMessage): Promise<AgentRunResult> {
    let usedTools = false;
    const first = await this.primary.run(request, (m) => {
      if (m.type === "tool_use") usedTools = true;
      onMessage?.(m);
    });
    if (request.signal?.aborted || !this.shouldFallback(first, { usedTools })) return first;
    const why = isUsageLimit(first) ? "hit a limit" : `couldn't run (${first.error})`;
    onMessage?.({ type: "system", text: `${this.primary.name} ${why}; retrying on ${this.fallback.name}` });
    // The fallback can't resume the primary's session, so it gets the prompt that carries the context.
    const { promptWithoutResume, ...rest } = request;
    return this.fallback.run({ ...rest, prompt: request.resumeSessionId ? (promptWithoutResume ?? request.prompt) : request.prompt, resumeSessionId: undefined }, onMessage);
  }
}

/**
 * Chains runners in order, each the fallback of the one before (a single runner is returned as is).
 * The chain is named after its first runner.
 */
export function fallbackChain(runners: AgentRunner[], shouldFallback: ShouldFallback = nextAgent): AgentRunner {
  if (!runners.length) throw new Error("fallbackChain needs at least one runner");
  return runners.reduceRight((next, runner) => new FallbackRunner(runner.name, runner, next, shouldFallback));
}
