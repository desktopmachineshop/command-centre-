import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@cc/core";
import { describe, expect, it } from "vitest";
import { fallbackChain, FallbackRunner, GeminiRunner, isUsageLimit, type McpConnect, RoutedRunner, ScriptedRunner } from "../src";

type Reply = { status?: number; body: unknown };
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP" }] });
const call = (name: string, args: unknown) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] });

/** A fake Gemini API answering with `replies` in turn, recording each request body. */
function fakeApi(replies: Reply[]) {
  const bodies: any[] = [];
  const headers: Record<string, string>[] = [];
  const f = (async (url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    headers.push(init.headers as Record<string, string>);
    const r = replies.shift() ?? { body: text("done") };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, bodies, headers };
}

/** One fake MCP server, "brain", with a search tool. */
function fakeMcp(calls: unknown[] = []): McpConnect {
  return async () => ({
    listTools: async () => [
      { name: "search", description: "Search notes", inputSchema: { $schema: "x", type: "object", properties: { query: { type: "string" } }, additionalProperties: false } },
      { name: "write", description: "Write a note", inputSchema: { type: "object" } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `found for ${String(args.query)}` }] };
    },
    close: async () => {},
  });
}

const servers = { brain: { type: "http" as const, url: "http://x/mcp/brain" } };

describe("GeminiRunner", () => {
  it("calls the MCP tools it is allowed and returns the final answer", async () => {
    const api = fakeApi([{ body: call("mcp__brain__search", { query: "pumps" }) }, { body: text("Here is what I found.") }]);
    const calls: unknown[] = [];
    const messages: AgentMessage[] = [];
    const runner = new GeminiRunner({ apiKey: "AIza-test", fetch: api.f, connectMcp: fakeMcp(calls) });
    const result = await runner.run({ prompt: "find pumps", systemPrompt: "Be brief.", mcpServers: servers, allowedTools: ["mcp__brain__search"] }, (m) => messages.push(m));

    expect(result).toMatchObject({ status: "succeeded", result: "Here is what I found.", error: null });
    expect(calls).toEqual([{ name: "search", args: { query: "pumps" } }]);
    expect(api.headers[0]!["x-goog-api-key"]).toBe("AIza-test");
    // Only the allowed tool, with a schema Gemini accepts.
    expect(api.bodies[0].tools[0].functionDeclarations).toEqual([
      { name: "mcp__brain__search", description: "Search notes", parametersJsonSchema: { type: "object", properties: { query: { type: "string" } } } },
    ]);
    expect(api.bodies[0].systemInstruction.parts[0].text).toBe("Be brief.");
    // The tool's answer goes back as a function response.
    expect(api.bodies[1].contents.at(-1)).toEqual({ role: "user", parts: [{ functionResponse: { name: "mcp__brain__search", response: { result: "found for pumps" } } }] });
    expect(messages.map((m) => m.type)).toEqual(["system", "tool_use", "tool_result", "text"]);
  });

  it("says it isn't connected without a key, and isn't available for shell tasks", async () => {
    expect(await new GeminiRunner().run({ prompt: "hi" })).toMatchObject({ status: "failed", error: expect.stringMatching(/isn't connected/) });
    expect(await new GeminiRunner({ apiKey: "k" }).run({ prompt: "hi", allowedTools: ["Bash"] })).toMatchObject({ status: "failed", error: expect.stringMatching(/isn't available/) });
  });

  it("words a 429 as a limit and a refused key as not connected", async () => {
    const limited = await new GeminiRunner({ apiKey: "k", fetch: fakeApi([{ status: 429, body: { error: { message: "Resource exhausted" } } }]).f }).run({ prompt: "hi" });
    expect(limited.error).toMatch(/rate limit or quota/);
    const refused = await new GeminiRunner({ apiKey: "k", fetch: fakeApi([{ status: 400, body: { error: { message: "API key not valid." } } }]).f }).run({ prompt: "hi" });
    expect(refused.error).toMatch(/isn't connected/);
  });

  it("stops at maxTurns", async () => {
    const api = fakeApi([{ body: call("mcp__brain__search", { query: "a" }) }, { body: call("mcp__brain__search", { query: "b" }) }]);
    const r = await new GeminiRunner({ apiKey: "k", fetch: api.f, connectMcp: fakeMcp() }).run({ prompt: "x", mcpServers: servers, allowedTools: ["mcp__brain"], maxTurns: 2 });
    expect(r).toMatchObject({ status: "failed", error: "Reached the maximum number of turns (2)" });
  });

  it("resumes its own saved conversation, and starts afresh from another runner's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-gemini-"));
    const api = fakeApi([{ body: text("first") }, { body: text("second") }, { body: text("third") }]);
    const runner = new GeminiRunner({ apiKey: "k", fetch: api.f, sessionsDir: dir });
    const one = await runner.run({ prompt: "hello" });
    expect(one.sessionId).toMatch(/^gemini:/);
    expect(readdirSync(dir)).toHaveLength(1);

    await runner.run({ prompt: "and then?", resumeSessionId: one.sessionId!, promptWithoutResume: "context + and then?" });
    expect(api.bodies[1].contents.map((c: any) => c.parts[0].text)).toEqual(["hello", "first", "and then?"]);

    await runner.run({ prompt: "and then?", resumeSessionId: "claude-session-1", promptWithoutResume: "context + and then?" });
    expect(api.bodies[2].contents.map((c: any) => c.parts[0].text)).toEqual(["context + and then?"]);
  });
});

describe("fallback chain", () => {
  const failing = (name: string, error: string, tool = false) =>
    new ScriptedRunner(name, () => ({
      messages: tool ? [{ type: "tool_use", name: "mcp__actions__propose", input: {} }] : [],
      result: { status: "failed", result: null, error, costUsd: null, sessionId: null },
    }));

  it("moves along the route when an agent isn't available, is at its limit, or failed before doing anything", async () => {
    const last = new ScriptedRunner("claude-code");
    const messages: string[] = [];
    const chain = fallbackChain([failing("gemini", "Google AI Studio isn't connected"), failing("codex", "usage limit reached"), failing("other", "Timed out after 1ms"), last]);
    expect(chain.name).toBe("gemini");
    expect((await chain.run({ prompt: "hi" }, (m) => m.type === "system" && messages.push(m.text))).result).toBe("echo: hi");
    expect(messages).toEqual([
      "gemini couldn't run (Google AI Studio isn't connected); retrying on codex",
      "codex hit a limit; retrying on other",
      "other couldn't run (Timed out after 1ms); retrying on claude-code",
    ]);
  });

  it("doesn't retry a run that failed after using tools, or one that was stopped", async () => {
    const next = new ScriptedRunner("next");
    expect((await fallbackChain([failing("first", "something broke", true), next]).run({ prompt: "hi" })).error).toBe("something broke");
    const stop = new AbortController();
    stop.abort();
    expect((await fallbackChain([failing("first", "Aborted"), next]).run({ prompt: "hi", signal: stop.signal })).error).toBe("Aborted");
    expect(next.calls).toHaveLength(0);
  });

  it("still only falls back at a limit by default", async () => {
    const next = new ScriptedRunner("next");
    expect((await new FallbackRunner("f", failing("first", "something broke"), next).run({ prompt: "hi" })).error).toBe("something broke");
  });
});

describe("RoutedRunner", () => {
  const recording = (name: string, error?: string) => {
    const r = new ScriptedRunner(name, (req) => ({
      result: error ? { status: "failed", result: null, error, costUsd: null, sessionId: null } : { status: "succeeded", result: `${name}:${req.model ?? "default"}`, error: null, costUsd: null, sessionId: null },
    }));
    return r;
  };

  it("starts on the picked provider with its model, then the route without it", async () => {
    const claude = recording("claude-code");
    const gemini = recording("gemini", "Google AI Studio isn't connected");
    const codex = recording("codex");
    const routed = new RoutedRunner({ runners: { claude, gemini, codex }, route: ["claude", "codex"] });
    expect(routed.name).toBe("claude-code");
    expect(routed.order("gemini")).toEqual(["gemini", "claude", "codex"]);
    const r = await routed.run({ prompt: "hi", provider: "gemini", model: "gemini-flash-latest" });
    expect(gemini.calls[0]!.model).toBe("gemini-flash-latest");
    // Claude took over on its own default model.
    expect(r.result).toBe("claude-code:default");
    expect(claude.calls[0]!.model).toBeUndefined();
  });

  it("without a pick, runs the route as before", async () => {
    const claude = recording("claude-code");
    const routed = new RoutedRunner({ runners: { claude, gemini: recording("gemini") }, route: ["claude"] });
    expect((await routed.run({ prompt: "hi" })).result).toBe("claude-code:default");
    expect((await routed.run({ prompt: "hi", provider: "nope" })).result).toBe("claude-code:default");
  });

  it("ends on the last-resort runner at a limit", async () => {
    const key = recording("claude-code-api");
    const routed = new RoutedRunner({ runners: { claude: recording("claude-code", "usage limit reached") }, route: ["claude"], last: { runner: key, when: isUsageLimit } });
    expect((await routed.run({ prompt: "hi", provider: "claude", model: "opus" })).result).toBe("claude-code-api:opus");
  });
});
