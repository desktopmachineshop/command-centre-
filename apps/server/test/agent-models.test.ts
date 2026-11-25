import { ScriptedRunner } from "@cc/agent-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentModelCatalog } from "../src/agent-models";
import { loadConfig } from "../src/config";
import { agentChoiceOf } from "../src/pipeline";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

const config = (env: Record<string, string> = {}) => loadConfig({ DATABASE_URL: "postgres://x", ADMIN_TOKEN: ADMIN, ...env });

describe("agentChoiceOf", () => {
  const chat = { source: "chat" as const, payload: { agent: { provider: "gemini", model: "gemini-flash-latest" } } };
  it("takes the reply's pick, then the chat's, then the specialist's", () => {
    expect(agentChoiceOf({ provider: "codex" }, chat, { provider: "claude", model: "opus" })).toEqual({ provider: "codex" });
    expect(agentChoiceOf(undefined, chat, { provider: "claude", model: "opus" })).toEqual({ provider: "gemini", model: "gemini-flash-latest" });
    expect(agentChoiceOf(undefined, { source: "system", payload: {} }, { provider: "claude", model: "opus" })).toEqual({ provider: "claude", model: "opus" });
    expect(agentChoiceOf(undefined, null, undefined)).toEqual({});
  });

  it("ignores a pick from outside input, or one that isn't valid", () => {
    expect(agentChoiceOf(undefined, { source: "email", payload: { agent: { provider: "gemini" } } }, undefined)).toEqual({});
    expect(agentChoiceOf(undefined, { source: "chat", payload: { agent: { provider: "llama" } } }, undefined)).toEqual({});
  });
});

describe("AgentModelCatalog", () => {
  it("lists each provider with its default first, and Gemini's live models from the key", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>)["x-goog-api-key"]}`);
      return new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
            { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
          ],
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const catalog = new AgentModelCatalog(() => config({ AGENT_ROUTE: "claude-then-gemini", GEMINI_API_KEY: "AIza-k", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }), fetch, "https://g.test/v1beta");
    const list = await catalog.list();
    expect(list.route).toEqual(["claude", "gemini"]);
    const [claude, codex, gemini] = list.providers;
    expect(claude).toMatchObject({ id: "claude", connected: true, routeIndex: 0 });
    expect(claude!.models.map((m) => m.id)).toEqual(["", "sonnet", "opus", "haiku"]);
    expect(codex).toMatchObject({ id: "codex", connected: false, routeIndex: null });
    expect(gemini).toMatchObject({ id: "gemini", connected: true, routeIndex: 1 });
    expect(gemini!.models.map((m) => m.id)).toEqual(["", "gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-pro"]);
    await catalog.list();
    expect(seen).toEqual(["https://g.test/v1beta/models?pageSize=200 AIza-k"]); // cached
  });

  it("falls back to the fixed Gemini list without a key", async () => {
    const list = await new AgentModelCatalog(() => config(), (() => Promise.reject(new Error("no"))) as unknown as typeof fetch).list();
    expect(list.providers[2]!.models.map((m) => m.id)).toContain("gemini-flash-latest");
  });
});

describe.skipIf(!DB_URL)("the model picker reaches the agent (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new ScriptedRunner();

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(() => {
    runner.calls.length = 0;
  });

  it("lists the choices", async () => {
    const { status, body } = await ctx.api("/api/agents/models");
    expect(status).toBe(200);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["claude", "codex", "gemini"]);
  });

  it("runs a chat, and each reply, on the picked provider and model", async () => {
    const { status, body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: what sold?", agent: { provider: "gemini", model: "gemini-flash-latest" } } });
    expect(status).toBe(201);
    await ctx.queue.drain();
    expect(runner.calls[0]).toMatchObject({ provider: "gemini", model: "gemini-flash-latest" });

    // A reply keeps the chat's pick unless it names its own.
    await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "and today?" } });
    await ctx.queue.drain();
    expect(runner.calls[1]).toMatchObject({ provider: "gemini", model: "gemini-flash-latest" });
    await ctx.api(`/api/tasks/${body.task.id}/reply`, { method: "POST", json: { text: "again", agent: { provider: "claude", model: "opus" } } });
    await ctx.queue.drain();
    expect(runner.calls[2]).toMatchObject({ provider: "claude", model: "opus" });
  });

  it("leaves the route alone without a pick, and refuses an unknown provider", async () => {
    await ctx.api("/api/chat", { method: "POST", json: { text: "dms: hello" } });
    await ctx.queue.drain();
    expect(runner.calls[0]!.provider).toBeUndefined();
    expect((await ctx.api("/api/chat", { method: "POST", json: { text: "hi", agent: { provider: "llama" } } })).status).toBe(400);
  });
});
