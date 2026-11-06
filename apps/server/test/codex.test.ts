import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentEnv, createRunner } from "../src/app";
import { CodexHome, codexAuthInfo, codexAuthProblem } from "../src/codex-home";
import { loadConfig } from "../src/config";
import { CodexSetup } from "../src/integrations/codex-setup";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("../../../packages/agent-runtime/test/fixtures/fake-claude.mjs", import.meta.url));
const setupDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith("cc-codex-setup-"));
const authJson = (refresh: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "h.e30.s", access_token: "at", refresh_token: refresh, account_id: "a" } });

function config(env: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: "postgres://x",
    ADMIN_TOKEN: ADMIN,
    DATA_DIR: mkdtempSync(join(tmpdir(), "cc-codex-data-")),
    CODEX_BIN: FAKE_CODEX,
    CLAUDE_BIN: FAKE_CLAUDE,
    ...env,
  });
}

describe("codex sign-in file", () => {
  it("accepts a ChatGPT sign-in and refuses an API key or junk", () => {
    expect(codexAuthProblem(authJson("rt"))).toBeNull();
    expect(codexAuthProblem(JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null }))).toMatch(/API key, not a ChatGPT sign-in/);
    expect(codexAuthProblem("not json")).toMatch(/isn't the JSON/);
  });

  it("reads the account and plan from the id token", () => {
    const idToken = `h.${Buffer.from(JSON.stringify({ email: "d@x.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })).toString("base64url")}.s`;
    expect(codexAuthInfo(JSON.stringify({ tokens: { id_token: idToken, refresh_token: "r" } }))).toEqual({ email: "d@x.com", plan: "pro" });
    expect(codexAuthInfo("{}")).toEqual({});
  });
});

describe("CodexHome", () => {
  it("seeds auth.json once, keeps Codex's refreshed tokens, and reseeds on a new sign-in", async () => {
    const rotated: string[] = [];
    const home = new CodexHome(mkdtempSync(join(tmpdir(), "cc-codex-home-")), async (j) => void rotated.push(j));
    const file = join(home.dir, "auth.json");
    const first = authJson("rt-1");

    expect(await home.prepare(first)).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(first);

    // Codex refreshed during a run: saved back once, and not overwritten by the older saved one.
    writeFileSync(file, authJson("rt-2"));
    await home.afterRun(first);
    await home.afterRun(first);
    expect(rotated).toEqual([authJson("rt-2")]);
    expect(await home.prepare(first)).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(authJson("rt-2"));

    // A new Connect replaces it.
    expect(await home.prepare(authJson("rt-new"))).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(authJson("rt-new"));
  });

  it("says how to connect, and removes the file, when there's no sign-in", async () => {
    const home = new CodexHome(mkdtempSync(join(tmpdir(), "cc-codex-home-")));
    await home.prepare(authJson("rt"));
    expect(await home.prepare(undefined)).toMatch(/isn't connected.*Accounts page/);
    expect(readdirSync(home.dir)).not.toContain("auth.json");
    expect(await home.prepare(JSON.stringify({ OPENAI_API_KEY: "sk" }))).toMatch(/can't be used/);
  });
});

describe("agent routes", () => {
  it("gives Codex no Claude settings and no tokens", () => {
    const env = agentEnv(config({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }), "codex", { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/c", OPENAI_API_KEY: "sk-x", ODOO_API_KEY: "o" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("codex: runs on the ChatGPT plan, and says so when it isn't connected", async () => {
    expect((await createRunner(config({ AGENT_ROUTE: "codex", CODEX_AUTH_JSON: authJson("rt") })).run({ prompt: "hi" })).result).toBe("codex: hi");
    const off = await createRunner(config({ AGENT_ROUTE: "codex" })).run({ prompt: "hi" });
    expect(off).toMatchObject({ status: "failed", error: expect.stringMatching(/isn't connected/) });
  });

  it("claude-then-codex: Claude first", async () => {
    const runner = createRunner(config({ AGENT_ROUTE: "claude-then-codex", CODEX_AUTH_JSON: authJson("rt") }));
    expect((await runner.run({ prompt: "hi" })).result).toBe("answer to hi");
  });

  it("codex-then-claude: Claude takes over at ChatGPT's limit, or when ChatGPT isn't connected", async () => {
    const messages: string[] = [];
    const limited = createRunner(config({ AGENT_ROUTE: "codex-then-claude", CODEX_AUTH_JSON: authJson("limit") }));
    expect((await limited.run({ prompt: "hi" }, (m) => m.type === "system" && messages.push(m.text))).result).toBe("answer to hi");
    expect(messages).toContain("codex hit a limit; retrying on claude-code");
    expect((await createRunner(config({ AGENT_ROUTE: "codex-then-claude" })).run({ prompt: "hi" })).result).toBe("answer to hi");
  });

  it("claude stays the default", () => {
    expect(createRunner(config()).name).toBe("claude-code");
  });
});

describe("CodexSetup (with a fake codex CLI)", () => {
  const setup = new CodexSetup({ bin: FAKE_CODEX, env: { PATH: process.env.PATH }, stepTimeoutMs: 10_000 });
  afterAll(() => setup.cancel());

  it("shows the device link and code, then hands over the sign-in file", async () => {
    const before = setupDirs().length;
    const { setupId, url, code } = await setup.start();
    expect(url).toBe("https://auth.openai.com/codex/device");
    expect(code).toBe("WXYZ-12345");
    expect(await setup.status(setupId)).toEqual({ status: "pending" });
    await new Promise((r) => setTimeout(r, 600));
    const done = await setup.status(setupId);
    expect(done).toMatchObject({ status: "signed-in" });
    expect(codexAuthProblem((done as { authJson: string }).authJson)).toBeNull();
    expect(setupDirs().length).toBe(before); // the throwaway CODEX_HOME is gone
    expect(await setup.status(setupId)).toMatchObject({ status: "failed", message: expect.stringMatching(/expired/) });
  });

  it("reports a sign-in that didn't finish", async () => {
    const failing = new CodexSetup({ bin: FAKE_CODEX, env: { PATH: process.env.PATH, FAKE_CODEX_LOGIN: "fail" }, stepTimeoutMs: 10_000 });
    const { setupId } = await failing.start();
    await new Promise((r) => setTimeout(r, 600));
    expect(await failing.status(setupId)).toEqual({ status: "failed", message: "ChatGPT sign-in didn't finish: Error: device code expired. Press Connect to try again." });
  });

  it("fails cleanly when the CLI never shows a link", async () => {
    await expect(new CodexSetup({ bin: "/bin/false", env: { PATH: process.env.PATH }, stepTimeoutMs: 5_000 }).start()).rejects.toThrow(/didn't show a sign-in link/);
  });
});

describe.skipIf(!DB_URL)("Connect ChatGPT API and the agent route", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { codexSetupBin: FAKE_CODEX } });
  });
  afterAll(() => ctx.server.stop());

  it("saves the sign-in encrypted, never showing it, and leaves the route alone", async () => {
    const log = vi.spyOn(console, "log");
    const start = await ctx.api("/api/integrations/codex/setup", { method: "POST" });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "WXYZ-12345" });
    let done = await ctx.api(`/api/integrations/codex/setup/${start.body.setupId}`);
    for (let i = 0; i < 40 && done.body.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      done = await ctx.api(`/api/integrations/codex/setup/${start.body.setupId}`);
    }
    expect(done.body).toMatchObject({ status: "connected", ok: true, account: "dave@example.com (ChatGPT plus)" });
    expect(ctx.server.integrations.current().agent).toMatchObject({ route: "claude", codexAuth: expect.stringContaining("rt-secret-1") });
    const { rows } = await ctx.server.store.pool.query("select * from integration_entries where kind = 'codex'");
    expect(JSON.stringify(rows)).not.toContain("rt-secret-1");
    expect(JSON.stringify(log.mock.calls)).not.toContain("rt-secret-1");
    expect(JSON.stringify((await ctx.api("/api/integrations")).body)).not.toContain("rt-secret-1");
    expect((await ctx.api("/api/integrations/codex/default/test", { method: "POST" })).body).toMatchObject({ ok: true, message: expect.stringContaining("dave@example.com") });
  });

  it("switches the route from the Accounts page, and refuses one that doesn't exist", async () => {
    expect((await ctx.api("/api/integrations/agents/default", { method: "PUT", json: { data: { route: "codex-then-claude" } } })).status).toBe(200);
    expect(ctx.server.integrations.current().agent.route).toBe("codex-then-claude");
    expect((await ctx.api("/api/integrations/agents/default", { method: "PUT", json: { data: { route: "gemini" } } })).status).toBe(400);
  });

  it("needs a signed-in caller", async () => {
    expect((await ctx.server.app.request("/api/integrations/codex/setup", { method: "POST" })).status).toBe(401);
  });
});

describe.skipIf(!DB_URL)("agents on the codex route", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { AGENT_RUNNER: "claude-code", AGENT_ROUTE: "codex", CODEX_BIN: FAKE_CODEX, VOICE_FRONT: "off" } });
  });
  afterAll(() => ctx.server.stop());

  it("runs a chat task on ChatGPT and saves the tokens Codex refreshed", async () => {
    await ctx.api("/api/integrations/codex/default", { method: "PUT", json: { secrets: { authJson: authJson("rotate") } } });
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: what sold yesterday?" } });
    await ctx.queue.drain();
    const detail = (await ctx.api(`/api/tasks/${body.task.id}`)).body;
    expect(detail.task.status).toBe("done");
    expect(detail.runs[0]).toMatchObject({ runner: "codex", status: "succeeded", result: "codex: dms: what sold yesterday?" });
    const entry = await ctx.server.integrations.entry("codex", "default");
    expect(JSON.parse(entry!.secrets.authJson!).tokens.refresh_token).toBe("rotated");
  });
});

