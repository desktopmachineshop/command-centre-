import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentMessage } from "@cc/core";
import type { AgentRunner, AgentRunRequest, AgentRunResult, OnAgentMessage } from "./runner";

export interface ClaudeCodeRunnerOptions {
  name?: string;
  /** Path to the `claude` binary. */
  bin?: string;
  /** Environment for the child process. Defaults to the server's environment. */
  env?: NodeJS.ProcessEnv;
  /** Kill the run after this long. */
  timeoutMs?: number;
}

/**
 * Runs Claude Code headless (`claude -p --output-format stream-json`).
 * Auth comes from the environment: CLAUDE_CODE_OAUTH_TOKEN (subscription,
 * from `claude setup-token`) or ANTHROPIC_API_KEY.
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly name: string;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.name = options.name ?? "claude-code";
    this.bin = options.bin ?? "claude";
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  buildArgs(request: AgentRunRequest): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);
    if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: request.mcpServers }), "--strict-mcp-config");
    }
    if (request.allowedTools?.length) args.push("--allowedTools", request.allowedTools.join(","));
    if (request.maxTurns) args.push("--max-turns", String(request.maxTurns));
    if (request.model) args.push("--model", request.model);
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    return args;
  }

  run(request: AgentRunRequest, onMessage: OnAgentMessage = () => {}): Promise<AgentRunResult> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, this.buildArgs(request), {
        cwd: request.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const parser = new StreamJsonParser(onMessage);
      let stderr = "";
      let settled = false;
      const finish = (result: AgentRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const failed = (error: string): AgentRunResult => ({
        status: "failed",
        result: parser.result,
        error,
        costUsd: parser.costUsd,
        sessionId: parser.sessionId,
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(failed(`Timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(failed("Aborted"));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      createInterface({ input: child.stdout }).on("line", (line) => parser.push(line));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("error", (err) => finish(failed(`Failed to start ${this.bin}: ${err.message}`)));
      child.on("close", (code) => {
        if (parser.final) return finish(parser.final);
        finish(failed(`claude exited with code ${code} without a result. ${stderr.trim()}`.trim()));
      });

      child.stdin.end(request.prompt);
    });
  }
}

/** Turns Claude Code stream-json lines into normalised AgentMessages and a final result. */
export class StreamJsonParser {
  sessionId: string | null = null;
  costUsd: number | null = null;
  result: string | null = null;
  final: AgentRunResult | null = null;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly onMessage: OnAgentMessage) {}

  push(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof msg.session_id === "string") this.sessionId = msg.session_id;

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.emit({ type: "system", text: `session ${msg.session_id ?? "?"} started` });
        break;
      case "assistant":
        for (const block of contentBlocks(msg)) {
          if (block.type === "text" && block.text) this.emit({ type: "text", text: block.text });
          if (block.type === "tool_use") {
            if (block.id) this.toolNames.set(block.id, block.name);
            this.emit({ type: "tool_use", name: block.name, input: block.input });
          }
        }
        break;
      case "user":
        for (const block of contentBlocks(msg)) {
          if (block.type === "tool_result") {
            this.emit({
              type: "tool_result",
              name: this.toolNames.get(block.tool_use_id),
              output: block.content,
              isError: block.is_error === true,
            });
          }
        }
        break;
      case "result": {
        this.costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
        this.result = typeof msg.result === "string" ? msg.result : null;
        const ok = msg.subtype === "success" && msg.is_error !== true;
        this.final = {
          status: ok ? "succeeded" : "failed",
          result: this.result,
          error: ok ? null : (this.result ?? msg.subtype ?? "Agent run failed"),
          costUsd: this.costUsd,
          sessionId: this.sessionId,
        };
        break;
      }
    }
  }

  private emit(message: AgentMessage) {
    this.onMessage(message);
  }
}

function contentBlocks(msg: any): any[] {
  const content = msg?.message?.content;
  return Array.isArray(content) ? content : [];
}
