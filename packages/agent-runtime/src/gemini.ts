import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { developerInstructions } from "./codex";
import type { AgentRunner, AgentRunRequest, AgentRunResult, McpServerConfig, OnAgentMessage } from "./runner";

/** Gemini session ids are given out as `gemini:<id>`, so no other runner tries to resume one. */
export const GEMINI_SESSION = "gemini:";
export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
/** Google's alias for its current Pro model, so the default doesn't go stale. */
export const GEMINI_DEFAULT_MODEL = "gemini-pro-latest";

/** One MCP tool, as the runner sees it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A connection to one MCP server (the SDK client by default; tests use a fake). */
export interface McpConnection {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}
export type McpConnect = (name: string, server: McpServerConfig) => Promise<McpConnection>;

export interface GeminiRunnerOptions {
  name?: string;
  /** Google AI Studio API key (aistudio.google.com/apikey). Unset: every run fails as "isn't connected". */
  apiKey?: string;
  /** Model for every run; default gemini-pro-latest. */
  model?: string;
  /** Base URL of the Gemini API (tests use a fake). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Where conversations are kept so a follow-up can resume them. Unset: no resume. */
  sessionsDir?: string;
  timeoutMs?: number;
  connectMcp?: McpConnect;
}

type Part = Record<string, any>;
type Content = { role: "user" | "model"; parts: Part[] };

/** Gemini's function names: letters, digits, _ . : - and at most 64 characters. */
const NAME_OK = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic" };
const MAX_TOOL_OUTPUT = 60_000;

/**
 * Runs agents on Google's Gemini models with a Google AI Studio API key, through the Gemini API
 * directly (no CLI). It takes the same requests as the other runners:
 *
 * - The tools are the MCP servers `allowedTools` names (`mcp__brain`, or single tools
 *   `mcp__brain__search`), called by the runner itself. There is no shell, file access or web
 *   search: a request that needs the shell ("Bash") fails at once as not available here, so a
 *   route moves it to the next agent.
 * - The system prompt and the run's skills go in as the system instruction (as for Codex).
 * - `maxTurns` bounds the model calls; the timeout bounds the run.
 * - Conversations are saved under `sessionsDir` as `gemini:<id>` so a reply can resume one.
 */
export class GeminiRunner implements AgentRunner {
  readonly name: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly connectMcp: McpConnect;

  constructor(private readonly options: GeminiRunnerOptions = {}) {
    this.name = options.name ?? "gemini";
    this.model = options.model?.trim() || GEMINI_DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? GEMINI_API).replace(/\/$/, "");
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.connectMcp = options.connectMcp ?? sdkConnect;
  }

  async run(request: AgentRunRequest, onMessage: OnAgentMessage = () => {}): Promise<AgentRunResult> {
    const failed = (error: string, sessionId: string | null = null): AgentRunResult => ({ status: "failed", result: null, error, costUsd: null, sessionId });
    if (!this.options.apiKey) return failed("Google AI Studio isn't connected: add an API key on the Accounts page");
    const allowed = request.allowedTools ?? [];
    if (allowed.some((t) => t === "Bash" || t.startsWith("Bash("))) return failed("Gemini isn't available for this task: it needs a shell, which the Gemini runner doesn't have");

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const why = () => (request.signal?.aborted ? "Aborted" : `Timed out after ${this.timeoutMs}ms`);

    // Resume only our own conversations; anything else starts afresh with the context spelled out.
    const own = request.resumeSessionId?.startsWith(GEMINI_SESSION) ? request.resumeSessionId.slice(GEMINI_SESSION.length) : undefined;
    const history = own ? this.load(own) : null;
    const id = history ? own! : randomUUID();
    const sessionId = this.options.sessionsDir ? `${GEMINI_SESSION}${id}` : null;
    const contents: Content[] = history ?? [];
    const prompt = request.resumeSessionId && !history ? (request.promptWithoutResume ?? request.prompt) : request.prompt;
    contents.push({ role: "user", parts: [{ text: prompt }, ...imageParts(request.images ?? [])] });
    onMessage({ type: "system", text: `session ${sessionId ?? "?"} started` });

    const connections: McpConnection[] = [];
    let result: string | null = null;
    try {
      const tools = await this.tools(request, allowed, connections);
      const system = developerInstructions(request, false);
      // A role's Claude model name ("sonnet") means nothing here.
      const model = request.model && !/claude|sonnet|opus|haiku|fable|gpt|codex/i.test(request.model) ? request.model : this.model;
      const maxTurns = request.maxTurns ?? 30;
      for (let turn = 0; ; turn++) {
        if (signal.aborted) return { ...failed(why(), sessionId), result };
        if (turn >= maxTurns) return { ...failed(`Reached the maximum number of turns (${maxTurns})`, sessionId), result };
        const res = await this.generate(model, contents, system, [...tools.values()].map((t) => t.declaration), signal);
        if ("error" in res) return { ...failed(res.error, sessionId), result };
        const content: Content = { role: "model", parts: res.parts };
        contents.push(content);
        const text = res.parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
        if (text.trim()) {
          result = text;
          onMessage({ type: "text", text });
        }
        const calls = res.parts.filter((p) => p.functionCall);
        if (!calls.length) {
          if (res.finishReason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(res.finishReason) && !result) {
            return failed(`Gemini stopped the answer (${res.finishReason})`, sessionId);
          }
          this.save(id, contents);
          return { status: "succeeded", result, error: null, costUsd: null, sessionId };
        }
        const responses: Part[] = [];
        for (const { functionCall: call } of calls) {
          const tool = tools.get(call.name);
          const name = tool?.mcpName ?? call.name;
          const args = (call.args ?? {}) as Record<string, unknown>;
          onMessage({ type: "tool_use", name, input: args });
          let output: unknown;
          let isError = false;
          if (!tool) {
            output = `There is no tool called ${call.name}`;
            isError = true;
          } else {
            try {
              const r = await tool.connection.callTool(tool.tool, args, signal);
              output = r.content ?? null;
              isError = r.isError === true;
            } catch (err) {
              if (signal.aborted) return { ...failed(why(), sessionId), result };
              output = (err as Error).message;
              isError = true;
            }
          }
          onMessage({ type: "tool_result", name, output, isError });
          const response = isError ? { error: toolText(output) } : { result: toolText(output) };
          responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response } });
        }
        contents.push({ role: "user", parts: responses });
      }
    } catch (err) {
      return { ...failed(signal.aborted ? why() : (err as Error).message, sessionId), result };
    } finally {
      await Promise.allSettled(connections.map((c) => c.close()));
    }
  }

  /** The MCP tools the run may use, keyed by the function name Gemini sees. */
  private async tools(request: AgentRunRequest, allowed: string[], connections: McpConnection[]) {
    const out = new Map<string, { declaration: Record<string, unknown>; mcpName: string; tool: string; connection: McpConnection }>();
    for (const [server, config] of Object.entries(request.mcpServers ?? {})) {
      const whole = allowed.includes(`mcp__${server}`);
      const prefix = `mcp__${server}__`;
      const only = allowed.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
      if (!whole && !only.length) continue;
      const connection = await this.connectMcp(server, config).catch((err: Error) => {
        throw new Error(`Couldn't reach the ${server} tools: ${err.message}`);
      });
      connections.push(connection);
      for (const tool of await connection.listTools()) {
        if (!whole && !only.includes(tool.name)) continue;
        const mcpName = `${prefix}${tool.name}`;
        const fn = functionName(mcpName, out);
        out.set(fn, {
          mcpName,
          tool: tool.name,
          connection,
          declaration: { name: fn, description: (tool.description ?? "").slice(0, 4000), parametersJsonSchema: cleanSchema(tool.inputSchema) },
        });
      }
    }
    return out;
  }

  private async generate(model: string, contents: Content[], system: string, functionDeclarations: Record<string, unknown>[], signal: AbortSignal): Promise<{ parts: Part[]; finishReason?: string } | { error: string }> {
    const body = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
    };
    const res = await this.fetch(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey! },
      body: JSON.stringify(body),
      signal,
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) return { error: apiError(res.status, json) };
    const candidate = json?.candidates?.[0];
    if (!candidate?.content?.parts) {
      const blocked = json?.promptFeedback?.blockReason;
      return { error: blocked ? `Gemini refused the prompt (${blocked})` : `Gemini returned no answer${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}` };
    }
    return { parts: candidate.content.parts, finishReason: candidate.finishReason };
  }

  private load(id: string): Content[] | null {
    if (!this.options.sessionsDir || !/^[\w-]+$/.test(id)) return null;
    try {
      const saved = JSON.parse(readFileSync(join(this.options.sessionsDir, `${id}.json`), "utf8"));
      return Array.isArray(saved) ? saved : null;
    } catch {
      return null;
    }
  }

  private save(id: string, contents: Content[]) {
    if (!this.options.sessionsDir) return;
    try {
      mkdirSync(this.options.sessionsDir, { recursive: true });
      // Images are not kept: a resumed conversation names them, it doesn't carry them again.
      const slim = contents.map((c) => ({ ...c, parts: c.parts.map((p) => (p.inlineData ? { text: "(an image was attached here)" } : p)) }));
      writeFileSync(join(this.options.sessionsDir, `${id}.json`), JSON.stringify(slim));
    } catch (err) {
      console.error(`[${this.name}] couldn't save the conversation:`, (err as Error).message);
    }
  }
}

/** The API's error, worded so the fallback can tell a limit or a bad key from anything else. */
function apiError(status: number, json: any): string {
  const message = typeof json?.error?.message === "string" ? json.error.message.slice(0, 500) : "";
  if (status === 429) return `Gemini hit its rate limit or quota${message ? `: ${message}` : ""}`;
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(message))) return `Google AI Studio isn't connected: the API key was refused${message ? ` (${message})` : ""}`;
  if (status === 503) return `Gemini is overloaded${message ? `: ${message}` : ""}`;
  if (status === 404) return `Gemini isn't available: the model wasn't found${message ? ` (${message})` : ""}`;
  return `Gemini API error ${status}${message ? `: ${message}` : ""}`;
}

/** An MCP name as a valid, unique Gemini function name. */
function functionName(mcpName: string, taken: Map<string, unknown>): string {
  let name = mcpName.replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (!NAME_OK.test(name)) name = `t_${name}`.slice(0, 64);
  for (let i = 2; taken.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
  return name;
}

/** JSON Schema minus the keys the Gemini API refuses. */
function cleanSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "$schema" && k !== "additionalProperties") out[k] = strip(x);
    return out;
  };
  return { type: "object", properties: {}, ...(strip(schema) as Record<string, unknown>) };
}

function toolText(output: unknown): string {
  const text = Array.isArray(output)
    ? output.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c))).join("\n")
    : typeof output === "string"
      ? output
      : JSON.stringify(output ?? null);
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n(cut short)` : text;
}

function imageParts(paths: string[]): Part[] {
  const parts: Part[] = [];
  for (const path of paths) {
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mimeType) continue;
    try {
      parts.push({ inlineData: { mimeType, data: readFileSync(path).toString("base64") } });
    } catch {
      parts.push({ text: `(The image ${path} couldn't be read.)` });
    }
  }
  return parts;
}

/** Connects with the MCP SDK: streamable HTTP for url servers, a child process for stdio ones. */
const sdkConnect: McpConnect = async (name, server) => {
  const client = new Client({ name: `command-centre-gemini-${name}`, version: "1.0.0" });
  const transport =
    "url" in server
      ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } })
      : new StdioClientTransport({ command: server.command, args: server.args, env: server.env });
  await client.connect(transport);
  return {
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...(page.tools as McpTool[]));
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(tool, args, signal) {
      const r = await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 600_000 });
      return { content: r.content, isError: r.isError === true };
    },
    close: () => client.close(),
  };
};
