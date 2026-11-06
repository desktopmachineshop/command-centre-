import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentMessage } from "@cc/core";
import type { AgentRunner, AgentRunRequest, AgentRunResult, McpServerConfig, OnAgentMessage } from "./runner";

export interface CodexRunnerOptions {
  name?: string;
  /** Path to the `codex` binary. */
  bin?: string;
  /** Environment for the child process (CODEX_HOME is set from `home`). */
  env?: NodeJS.ProcessEnv;
  /** CODEX_HOME: where Codex keeps its ChatGPT sign-in (auth.json) and sessions. */
  home?: string;
  /** Model for every run (e.g. "gpt-5-codex"); unset = Codex's default for the plan. */
  model?: string;
  /** Kill the run after this long. */
  timeoutMs?: number;
  /** Before each run: return a reason to fail it without starting Codex (e.g. not signed in). */
  prepare?: () => Promise<string | null | void>;
  /** After each run (whatever its outcome): e.g. save the tokens Codex refreshed. */
  afterRun?: () => Promise<void>;
}

/**
 * Features this runner never uses: apps, plugins, a browser, computer use, image generation,
 * sub-agents and hooks. Every name must be one the pinned Codex version knows (Dockerfile
 * CODEX_VERSION): an unknown name stops the run.
 */
const ALWAYS_OFF = ["apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation", "multi_agent", "hooks", "in_app_browser"];
/** The shell (and the image viewer, which reads any local file) unless the run allows Bash. */
const SHELL_FEATURES = ["shell_tool", "unified_exec", "view_image"];
/** A role's model names are Claude's ("sonnet", "claude-…"); Codex can't use them. */
const CLAUDE_MODEL = /claude|sonnet|opus|haiku|fable/i;
/** Linux caps one argument at 128 KiB; developer instructions over this are trimmed (skills first). */
const MAX_INSTRUCTIONS = 100_000;

/**
 * Runs OpenAI Codex headless (`codex exec --json`), signed in with a ChatGPT plan, so runs use
 * the plan's usage instead of API credits. It takes the same requests as ClaudeCodeRunner:
 *
 * - `allowedTools` decides the tools: MCP servers named there (`mcp__brain`, or single tools
 *   `mcp__brain__search`), the shell only with "Bash" (in Codex's workspace-write sandbox: the
 *   working folder is writable, the rest read-only, no network), web search with "WebSearch".
 *   With no Bash there is no shell at all, so a task from outside input gets none, as on Claude.
 * - The system prompt and the run's skills (`<cwd>/.claude/skills/<name>/SKILL.md`, inlined
 *   since Codex reads skill files through its shell) go in as developer instructions.
 * - `maxTurns` has no Codex equivalent; the timeout bounds the run.
 *
 * It never uses an API key (forced_login_method="chatgpt") and ignores any config.toml.
 */
export class CodexRunner implements AgentRunner {
  readonly name: string;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexRunnerOptions = {}) {
    this.name = options.name ?? "codex";
    this.bin = options.bin ?? "codex";
    this.env = { ...(options.env ?? process.env), ...(options.home ? { CODEX_HOME: options.home } : {}) };
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  buildArgs(request: AgentRunRequest): string[] {
    const allowed = request.allowedTools ?? [];
    const shell = allowed.some((t) => t === "Bash" || t.startsWith("Bash("));
    const args = request.resumeSessionId ? ["exec", "resume"] : ["exec"];
    args.push("--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules");
    for (const f of [...ALWAYS_OFF, ...(shell ? [] : SHELL_FEATURES)]) args.push("--disable", f);
    const set = (key: string, value: string) => args.push("-c", `${key}=${value}`);
    set("forced_login_method", '"chatgpt"');
    set("cli_auth_credentials_store", '"file"');
    set("approval_policy", '"never"');
    set("sandbox_mode", shell ? '"workspace-write"' : '"read-only"');
    set("web_search", allowed.includes("WebSearch") ? '"live"' : '"disabled"');
    const model = request.model && !CLAUDE_MODEL.test(request.model) ? request.model : this.options.model;
    if (model) set("model", tomlString(model));
    const instructions = developerInstructions(request, shell);
    if (instructions) set("developer_instructions", tomlString(instructions));
    for (const [name, server] of Object.entries(allowedMcpServers(request.mcpServers ?? {}, allowed))) {
      set(`mcp_servers.${tomlKey(name)}`, server);
    }
    if (request.resumeSessionId) args.push(request.resumeSessionId);
    args.push("-"); // the prompt comes on stdin
    return args;
  }

  async run(request: AgentRunRequest, onMessage: OnAgentMessage = () => {}): Promise<AgentRunResult> {
    const notReady = await this.options.prepare?.();
    if (notReady) return { status: "failed", result: null, error: notReady, costUsd: null, sessionId: null };
    try {
      // Only a Codex session can be resumed here (a Claude one, from before the route changed, can't).
      const own = request.resumeSessionId?.startsWith(CODEX_SESSION) ? request.resumeSessionId.slice(CODEX_SESSION.length) : undefined;
      const fresh = { ...request, prompt: request.resumeSessionId ? (request.promptWithoutResume ?? request.prompt) : request.prompt, resumeSessionId: undefined };
      if (!own) return await this.spawnRun(fresh, onMessage);
      const resumed = await this.spawnRun({ ...request, resumeSessionId: own }, onMessage);
      // The session is gone (Codex's folder was reset): start afresh with the context spelled out.
      if (resumed.status === "failed" && /no rollout found|thread\/resume failed/i.test(resumed.error ?? "")) return await this.spawnRun(fresh, onMessage);
      return resumed;
    } finally {
      await this.options.afterRun?.().catch((err) => console.error(`[${this.name}]`, (err as Error).message));
    }
  }

  private spawnRun(request: AgentRunRequest, onMessage: OnAgentMessage): Promise<AgentRunResult> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, this.buildArgs(request), {
        cwd: request.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const parser = new CodexJsonParser(onMessage);
      let stderr = "";
      let settled = false;
      const finish = (result: AgentRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const failed = (error: string): AgentRunResult => ({ status: "failed", result: parser.result, error, costUsd: null, sessionId: parser.sessionId });

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
        const reason = parser.lastError ?? lastLine(stderr);
        finish(failed(`codex exited with code ${code} without a result.${reason ? ` ${reason}` : ""}`));
      });

      child.stdin.on("error", () => {}); // a CLI that exits early closes stdin; the close handler reports it
      child.stdin.end(request.prompt);
    });
  }
}

/** Codex session ids are given out as `codex:<thread id>`, so no runner tries to resume another's. */
export const CODEX_SESSION = "codex:";

/** Turns `codex exec --json` lines into normalised AgentMessages and a final result. */
export class CodexJsonParser {
  sessionId: string | null = null;
  result: string | null = null;
  /** The last error event (Codex reports retries and fatal errors this way). */
  lastError: string | null = null;
  final: AgentRunResult | null = null;
  private readonly started = new Set<string>();

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
    switch (msg.type) {
      case "thread.started":
        if (typeof msg.thread_id === "string") this.sessionId = `${CODEX_SESSION}${msg.thread_id}`;
        this.emit({ type: "system", text: `session ${this.sessionId ?? "?"} started` });
        break;
      case "item.started":
        if (msg.item) this.toolUse(msg.item);
        break;
      case "item.completed":
        if (msg.item) this.completed(msg.item);
        break;
      case "error":
        if (typeof msg.message === "string") this.lastError = msg.message;
        break;
      case "turn.completed":
        this.final = { status: "succeeded", result: this.result, error: null, costUsd: null, sessionId: this.sessionId };
        break;
      case "turn.failed": {
        const error = typeof msg.error?.message === "string" ? msg.error.message : (this.lastError ?? "Agent run failed");
        this.final = { status: "failed", result: this.result, error, costUsd: null, sessionId: this.sessionId };
        break;
      }
    }
  }

  private toolUse(item: any) {
    const tool = toolOf(item);
    if (!tool || this.started.has(item.id)) return;
    if (item.id) this.started.add(item.id);
    this.emit({ type: "tool_use", name: tool.name, input: tool.input });
  }

  private completed(item: any) {
    switch (item.type) {
      case "agent_message": {
        const text = typeof item.text === "string" ? item.text : typeof item.message === "string" ? item.message : "";
        if (text) {
          this.result = text;
          this.emit({ type: "text", text });
        }
        return;
      }
      case "error":
        if (typeof item.message === "string") this.emit({ type: "system", text: item.message });
        return;
    }
    const tool = toolOf(item);
    if (!tool) return;
    this.toolUse(item);
    this.emit({ type: "tool_result", name: tool.name, output: tool.output, isError: tool.isError });
  }

  private emit(message: AgentMessage) {
    this.onMessage(message);
  }
}

/** The tool an item stands for, named the way Claude Code names its tools. */
function toolOf(item: any): { name: string; input: unknown; output: unknown; isError: boolean } | null {
  const failed = item.status === "failed" || item.status === "declined";
  switch (item.type) {
    case "mcp_tool_call":
      return {
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
        output: item.error?.message ?? item.result?.content ?? item.result ?? null,
        isError: failed || !!item.error,
      };
    case "command_execution":
      return {
        name: "Bash",
        input: { command: item.command },
        output: item.aggregated_output ?? null,
        isError: failed || (typeof item.exit_code === "number" && item.exit_code !== 0),
      };
    case "file_change":
      return { name: "Edit", input: { changes: item.changes }, output: item.status ?? null, isError: failed };
    case "web_search":
      return { name: "WebSearch", input: { query: item.query }, output: null, isError: failed };
    default:
      return null;
  }
}

/**
 * The MCP servers the run may use, as Codex `mcp_servers` TOML inline tables. A server is passed
 * only if allowedTools names it (`mcp__brain`) or some of its tools (`mcp__brain__search`, which
 * become its enabled_tools); Claude Code gets the same list as permission rules.
 */
export function allowedMcpServers(servers: Record<string, McpServerConfig>, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, server] of Object.entries(servers)) {
    const whole = allowed.includes(`mcp__${name}`);
    const prefix = `mcp__${name}__`;
    const tools = allowed.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
    if (!whole && !tools.length) continue;
    const fields: string[] = [];
    if ("url" in server) {
      fields.push(`url = ${tomlString(server.url)}`);
      if (server.headers && Object.keys(server.headers).length) fields.push(`http_headers = ${tomlTable(server.headers)}`);
    } else {
      fields.push(`command = ${tomlString(server.command)}`);
      if (server.args?.length) fields.push(`args = [${server.args.map(tomlString).join(", ")}]`);
      if (server.env && Object.keys(server.env).length) fields.push(`env = ${tomlTable(server.env)}`);
    }
    if (!whole) fields.push(`enabled_tools = [${tools.map(tomlString).join(", ")}]`);
    // Actions and research can take a while; Codex's default is 60 seconds.
    fields.push("tool_timeout_sec = 600");
    out[name] = `{ ${fields.join(", ")} }`;
  }
  return out;
}

/** The system prompt and the run's skills, as one developer message. */
function developerInstructions(request: AgentRunRequest, shell: boolean): string {
  const system = request.systemPrompt?.trim() ?? "";
  const skills = request.cwd ? readSkills(join(request.cwd, ".claude", "skills")) : [];
  if (!skills.length) return system.slice(0, MAX_INSTRUCTIONS);
  const intro = shell
    ? "## Skills\nThese are your skills. Follow one when the task matches its description. A skill's other files are in its folder, which you can read with the shell."
    : "## Skills\nThese are your skills. Follow one when the task matches its description.";
  let room = MAX_INSTRUCTIONS - system.length - intro.length - 4;
  const parts: string[] = [];
  for (const s of skills) {
    const block = `### Skill: ${s.name}${shell ? ` (folder ${s.dir})` : ""}\n${s.body.trim()}`;
    if (block.length > room) {
      parts.push(`### Skill: ${s.name}\n(Too long to include here.)`);
      continue;
    }
    parts.push(block);
    room -= block.length + 2;
  }
  return [system, intro, ...parts].filter(Boolean).join("\n\n").slice(0, MAX_INSTRUCTIONS);
}

function readSkills(dir: string): { name: string; dir: string; body: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: { name: string; dir: string; body: string }[] = [];
  for (const name of names) {
    try {
      out.push({ name, dir: join(dir, name), body: readFileSync(join(dir, name, "SKILL.md"), "utf8") });
    } catch {
      // not a skill folder
    }
  }
  return out;
}

/** A TOML basic string. JSON's escapes are TOML's, except DEL and lone surrogates, which TOML refuses. */
export function tomlString(s: string): string {
  return JSON.stringify(s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�")).replace(/\x7f/g, "\\u007f");
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function tomlTable(o: Record<string, string>): string {
  return `{ ${Object.entries(o).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(", ")} }`;
}

function lastLine(s: string): string {
  const lines = s.trim().split("\n").filter((l) => l.trim() && !/^WARNING: proceeding/.test(l));
  return (lines.at(-1) ?? "").trim().slice(0, 500);
}
