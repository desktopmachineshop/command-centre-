import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@cc/core";
import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner, FallbackRunner, ScriptedRunner } from "../src";

const fake = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

describe("ClaudeCodeRunner", () => {
  it("streams normalised messages and returns the result", async () => {
    const runner = new ClaudeCodeRunner({ bin: fake });
    const messages: AgentMessage[] = [];
    const result = await runner.run({ prompt: "hello" }, (m) => messages.push(m));

    expect(result).toEqual({ status: "succeeded", result: "answer to hello", error: null, costUsd: 0.01, sessionId: "sess-1" });
    expect(messages.map((m) => m.type)).toEqual(["system", "tool_use", "tool_result", "text"]);
    expect(messages[2]).toMatchObject({ type: "tool_result", name: "mcp__brain__search" });
  });

  it("reports a crash as a failed run", async () => {
    const runner = new ClaudeCodeRunner({ bin: fake, env: { ...process.env, FAKE_CLAUDE_MODE: "crash" } });
    const result = await runner.run({ prompt: "x" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code 3/);
  });

  it("reports a missing binary as a failed run", async () => {
    const result = await new ClaudeCodeRunner({ bin: "/nonexistent/claude" }).run({ prompt: "x" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Failed to start/);
  });

  it("builds CLI args from the request", () => {
    const args = new ClaudeCodeRunner().buildArgs({
      prompt: "p",
      systemPrompt: "sys",
      mcpServers: { brain: { command: "node", args: ["brain.js"] } },
      allowedTools: ["mcp__brain__search", "Read"],
      maxTurns: 5,
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__brain__search,Read");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({
      mcpServers: { brain: { command: "node", args: ["brain.js"] } },
    });
  });
});

describe("FallbackRunner", () => {
  it("falls back when the primary hits a usage limit", async () => {
    const primary = new ClaudeCodeRunner({ name: "sub", bin: fake, env: { ...process.env, FAKE_CLAUDE_MODE: "limit" } });
    const fallback = new ScriptedRunner("api");
    const result = await new FallbackRunner("claude", primary, fallback).run({ prompt: "hi" });
    expect(result.result).toBe("echo: hi");
    expect(fallback.calls).toHaveLength(1);
  });

  it("does not fall back on other failures", async () => {
    const primary = new ClaudeCodeRunner({ name: "sub", bin: fake, env: { ...process.env, FAKE_CLAUDE_MODE: "crash" } });
    const fallback = new ScriptedRunner("api");
    await new FallbackRunner("claude", primary, fallback).run({ prompt: "hi" });
    expect(fallback.calls).toHaveLength(0);
  });
});
