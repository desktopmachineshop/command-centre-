import type { AgentMessage } from "@cc/core";

/** MCP server definitions in the `mcpServers` shape Claude Code and the MCP SDKs share. */
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface AgentRunRequest {
  prompt: string;
  /** Appended to the runner's own system prompt. */
  systemPrompt?: string;
  /** Working directory; skills are discovered from `<cwd>/.claude/skills`. */
  cwd?: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** Tools the agent may use without asking, e.g. "mcp__brain__search". */
  allowedTools?: string[];
  maxTurns?: number;
  model?: string;
  /** Resume an earlier session of the same runner. */
  resumeSessionId?: string;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  status: "succeeded" | "failed";
  /** Final answer text. */
  result: string | null;
  error: string | null;
  costUsd: number | null;
  sessionId: string | null;
}

export type OnAgentMessage = (message: AgentMessage) => void;

/**
 * The standard harness: every agent backend (Claude Code, AI SDK models, ...)
 * implements this, so the server never cares which one does the work.
 */
export interface AgentRunner {
  readonly name: string;
  run(request: AgentRunRequest, onMessage?: OnAgentMessage): Promise<AgentRunResult>;
}

export class RunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  register(runner: AgentRunner): this {
    this.runners.set(runner.name, runner);
    return this;
  }

  get(name: string): AgentRunner {
    const runner = this.runners.get(name);
    if (!runner) throw new Error(`No agent runner registered as "${name}"`);
    return runner;
  }

  names(): string[] {
    return [...this.runners.keys()];
  }
}
