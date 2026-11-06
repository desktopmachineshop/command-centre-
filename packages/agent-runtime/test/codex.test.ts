import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@cc/core";
import { describe, expect, it } from "vitest";
import { ClaudeCodeRunner, CodexRunner, FallbackRunner, ScriptedRunner, tomlString } from "../src";

const fake = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const env = (mode?: string) => ({ ...process.env, ...(mode ? { FAKE_CODEX_MODE: mode } : {}) });

/** The value of a `-c key=value` override in args. */
const setting = (args: string[], key: string) => args.find((a, i) => args[i - 1] === "-c" && a.startsWith(`${key}=`))?.slice(key.length + 1);
const disabled = (args: string[]) => args.filter((_, i) => args[i - 1] === "--disable");

describe("CodexRunner", () => {
  it("streams normalised messages and returns the last agent message", async () => {
    const messages: AgentMessage[] = [];
    const result = await new CodexRunner({ bin: fake, env: env() }).run({ prompt: "hello" }, (m) => messages.push(m));

    expect(result).toEqual({ status: "succeeded", result: "answer to hello", error: null, costUsd: null, sessionId: "codex:thread-1" });
    expect(messages.map((m) => m.type)).toEqual(["system", "tool_use", "tool_result", "tool_use", "tool_result", "text"]);
    expect(messages[1]).toEqual({ type: "tool_use", name: "mcp__brain__search", input: { query: "hello" } });
    expect(messages[2]).toMatchObject({ type: "tool_result", name: "mcp__brain__search", output: [{ type: "text", text: "no notes" }], isError: false });
    expect(messages[4]).toMatchObject({ type: "tool_result", name: "Bash", isError: true });
  });

  it("reports a usage limit as a failed run the fallback recognises", async () => {
    const fallback = new ScriptedRunner("claude");
    const result = await new FallbackRunner("route", new CodexRunner({ bin: fake, env: env("limit") }), fallback).run({ prompt: "hi" });
    expect(result.result).toBe("echo: hi");
    expect(fallback.calls).toHaveLength(1);
  });

  it("reports a crash with the CLI's last words", async () => {
    const result = await new CodexRunner({ bin: fake, env: env("crash") }).run({ prompt: "x" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code 3.*something broke/);
  });

  it("reports a missing binary as a failed run", async () => {
    const result = await new CodexRunner({ bin: "/nonexistent/codex" }).run({ prompt: "x" });
    expect(result.error).toMatch(/Failed to start/);
  });

  it("fails without starting Codex when prepare says why, and always runs afterRun", async () => {
    let after = 0;
    const notReady = await new CodexRunner({ bin: fake, prepare: async () => "not signed in" }).run({ prompt: "x" });
    expect(notReady).toMatchObject({ status: "failed", error: "not signed in" });
    await new CodexRunner({ bin: fake, env: env("crash"), afterRun: async () => void after++ }).run({ prompt: "x" });
    expect(after).toBe(1);
  });

  it("passes CODEX_HOME and the working folder", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-cwd-"));
    const result = await new CodexRunner({ bin: fake, env: env("args"), home: "/data/codex" }).run({ prompt: "x", cwd });
    const seen = JSON.parse(result.result!);
    expect(seen.home).toBe("/data/codex");
    expect(seen.cwd).toContain("codex-cwd-");
    expect(seen.args.at(-1)).toBe("-");
  });

  it("gives no shell, no web and no MCP server the run wasn't allowed", () => {
    const args = new CodexRunner().buildArgs({
      prompt: "p",
      mcpServers: { brain: { type: "http", url: "http://x/mcp/brain" }, odoo: { type: "http", url: "http://x/mcp/odoo" } },
      allowedTools: ["Skill", "mcp__brain"],
    });
    expect(disabled(args)).toEqual(expect.arrayContaining(["shell_tool", "unified_exec", "view_image", "apps", "plugins"]));
    expect(setting(args, "sandbox_mode")).toBe('"read-only"');
    expect(setting(args, "web_search")).toBe('"disabled"');
    expect(setting(args, "forced_login_method")).toBe('"chatgpt"');
    expect(setting(args, "approval_policy")).toBe('"never"');
    expect(setting(args, "mcp_servers.brain")).toContain('url = "http://x/mcp/brain"');
    expect(setting(args, "mcp_servers.odoo")).toBeUndefined();
  });

  it("turns on the sandboxed shell with Bash, web search with WebSearch, and single MCP tools", () => {
    const args = new CodexRunner().buildArgs({
      prompt: "p",
      mcpServers: {
        actions: { type: "http", url: "http://x/mcp/actions", headers: { Authorization: "Bearer t\"1" } },
        local: { command: "node", args: ["s.js"], env: { A: "1" } },
      },
      allowedTools: ["Bash(git:*)", "WebSearch", "mcp__actions__propose", "mcp__local"],
    });
    expect(disabled(args)).not.toContain("shell_tool");
    expect(setting(args, "sandbox_mode")).toBe('"workspace-write"');
    expect(setting(args, "web_search")).toBe('"live"');
    expect(setting(args, "mcp_servers.actions")).toBe(
      '{ url = "http://x/mcp/actions", http_headers = { Authorization = "Bearer t\\"1" }, enabled_tools = ["propose"], tool_timeout_sec = 600 }',
    );
    expect(setting(args, "mcp_servers.local")).toBe('{ command = "node", args = ["s.js"], env = { A = "1" }, tool_timeout_sec = 600 }');
  });

  it("resumes a session, and ignores a Claude model name", () => {
    const args = new CodexRunner({ model: "gpt-5-codex" }).buildArgs({ prompt: "p", resumeSessionId: "thread-1", model: "sonnet" }); // run() strips the codex: prefix
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.slice(-2)).toEqual(["thread-1", "-"]);
    expect(setting(args, "model")).toBe('"gpt-5-codex"');
    expect(setting(new CodexRunner().buildArgs({ prompt: "p", model: "gpt-5" }), "model")).toBe('"gpt-5"');
  });

  it("puts the system prompt and the run's skills in the developer instructions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codex-skills-"));
    mkdirSync(join(cwd, ".claude", "skills", "pricing"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "pricing", "SKILL.md"), "---\nname: pricing\n---\nPrice things carefully.");
    mkdirSync(join(cwd, ".claude", "skills", "not-a-skill"), { recursive: true });
    const args = new CodexRunner().buildArgs({ prompt: "p", systemPrompt: "You are the DMS agent.", cwd });
    const instructions = JSON.parse(setting(args, "developer_instructions")!) as string;
    expect(instructions).toMatch(/^You are the DMS agent\.\n\n## Skills/);
    expect(instructions).toContain("### Skill: pricing\n---\nname: pricing\n---\nPrice things carefully.");
    expect(instructions).not.toContain("not-a-skill");
  });
});

describe("sessions across runners", () => {
  it("resumes its own codex: sessions and spells out the context for anyone else's", async () => {
    const runner = new CodexRunner({ bin: fake, env: env("args") });
    const own = JSON.parse((await runner.run({ prompt: "reply", resumeSessionId: "codex:thread-9", promptWithoutResume: "context + reply" })).result!);
    expect(own.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(own.args.at(-2)).toBe("thread-9");
    const claudes = JSON.parse((await runner.run({ prompt: "reply", resumeSessionId: "claude-sess", promptWithoutResume: "context + reply" })).result!);
    expect(claudes.args).not.toContain("resume");
  });

  it("Claude Code doesn't try to resume a Codex session", () => {
    const claude = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
    return new ClaudeCodeRunner({ bin: claude }).run({ prompt: "reply", resumeSessionId: "codex:thread-9", promptWithoutResume: "context" }).then((r) => {
      expect(r.result).toBe("answer to context");
    });
  });
});

describe("tomlString", () => {
  it("escapes what TOML basic strings can't hold", () => {
    expect(tomlString('a "b"\n\\c')).toBe('"a \\"b\\"\\n\\\\c"');
    expect(tomlString("del\x7f")).toBe('"del\\u007f"');
    expect(tomlString("lone \ud800 x")).toBe('"lone � x"');
    expect(tomlString("emoji 😀")).toBe('"emoji 😀"');
  });
});
