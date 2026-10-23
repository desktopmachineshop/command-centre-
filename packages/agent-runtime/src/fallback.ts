import type { AgentRunner, AgentRunRequest, AgentRunResult, OnAgentMessage } from "./runner";

const LIMIT_PATTERN = /usage limit|rate limit|limit reached|quota|overloaded/i;

/**
 * Runs `primary`; if it fails because of usage limits, re-runs on `fallback`
 * (e.g. subscription first, then API key).
 */
export class FallbackRunner implements AgentRunner {
  constructor(
    readonly name: string,
    private readonly primary: AgentRunner,
    private readonly fallback: AgentRunner,
    private readonly shouldFallback: (r: AgentRunResult) => boolean = (r) =>
      r.status === "failed" && LIMIT_PATTERN.test(r.error ?? ""),
  ) {}

  async run(request: AgentRunRequest, onMessage?: OnAgentMessage): Promise<AgentRunResult> {
    const first = await this.primary.run(request, onMessage);
    if (!this.shouldFallback(first)) return first;
    onMessage?.({ type: "system", text: `${this.primary.name} hit a limit; retrying on ${this.fallback.name}` });
    return this.fallback.run({ ...request, resumeSessionId: undefined }, onMessage);
  }
}
