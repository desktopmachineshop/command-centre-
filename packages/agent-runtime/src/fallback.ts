import type { AgentRunner, AgentRunRequest, AgentRunResult, OnAgentMessage } from "./runner";

const LIMIT_PATTERN = /usage limit|rate limit|limit reached|quota|overloaded/i;

/** A run that failed on a usage or rate limit (the next runner may still have room). */
export function isUsageLimit(r: AgentRunResult): boolean {
  return r.status === "failed" && LIMIT_PATTERN.test(r.error ?? "");
}

/**
 * Runs `primary`; if it fails because of usage limits, re-runs on `fallback`
 * (e.g. subscription first, then API key).
 */
export class FallbackRunner implements AgentRunner {
  constructor(
    readonly name: string,
    private readonly primary: AgentRunner,
    private readonly fallback: AgentRunner,
    private readonly shouldFallback: (r: AgentRunResult) => boolean = isUsageLimit,
  ) {}

  async run(request: AgentRunRequest, onMessage?: OnAgentMessage): Promise<AgentRunResult> {
    const first = await this.primary.run(request, onMessage);
    if (!this.shouldFallback(first)) return first;
    onMessage?.({ type: "system", text: `${this.primary.name} ${isUsageLimit(first) ? "hit a limit" : `couldn't run (${first.error})`}; retrying on ${this.fallback.name}` });
    // The fallback can't resume the primary's session, so it gets the prompt that carries the context.
    const { promptWithoutResume, ...rest } = request;
    return this.fallback.run({ ...rest, prompt: request.resumeSessionId ? (promptWithoutResume ?? request.prompt) : request.prompt, resumeSessionId: undefined }, onMessage);
  }
}
