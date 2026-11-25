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

/** `runner` with the request's `model` and `provider` dropped: for agents other than the one they were picked for. */
class WithoutModel implements AgentRunner {
  constructor(private readonly runner: AgentRunner) {}
  get name() {
    return this.runner.name;
  }
  run(request: AgentRunRequest, onMessage?: OnAgentMessage) {
    const { model: _m, provider: _p, ...rest } = request;
    return this.runner.run(rest, onMessage);
  }
}

export interface RoutedRunnerOptions {
  /** Each provider's runner ("claude", "codex", "gemini"). */
  runners: Record<string, AgentRunner>;
  /** The default order (the agent route). */
  route: string[];
  /** A runner after the whole route (the pay-as-you-go key), and when to move on to it. */
  last?: { runner: AgentRunner; when: ShouldFallback };
  shouldFallback?: ShouldFallback;
}

/**
 * The agent route, with a per-run choice: a request naming a `provider` (the chat's model picker,
 * a specialist's setting) starts on that provider, with its `model`, and falls back down the rest
 * of the route as usual. Agents other than the picked one run on their own default model.
 */
export class RoutedRunner implements AgentRunner {
  readonly name: string;

  constructor(private readonly options: RoutedRunnerOptions) {
    const first = options.route.find((p) => options.runners[p]) ?? Object.keys(options.runners)[0];
    if (!first) throw new Error("RoutedRunner needs at least one runner");
    this.name = options.runners[first]!.name;
  }

  /** The providers a run goes through, in order. */
  order(provider?: string): string[] {
    const route = this.options.route.filter((p) => this.options.runners[p]);
    if (!provider || !this.options.runners[provider]) return route;
    return [provider, ...route.filter((p) => p !== provider)];
  }

  run(request: AgentRunRequest, onMessage?: OnAgentMessage): Promise<AgentRunResult> {
    const picked = request.provider && this.options.runners[request.provider] ? request.provider : undefined;
    const runners = this.order(picked).map((p, i) => {
      const runner = this.options.runners[p]!;
      // The picked model is for the picked provider; without a pick, the request's model goes to all (as before).
      return picked && i > 0 ? new WithoutModel(runner) : runner;
    });
    let chain = fallbackChain(runners, this.options.shouldFallback ?? nextAgent);
    const last = this.options.last;
    if (last) chain = new FallbackRunner(chain.name, chain, picked && picked !== "claude" ? new WithoutModel(last.runner) : last.runner, last.when);
    return chain.run(request, onMessage);
  }
}
