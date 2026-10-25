import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeSetup } from "../src/integrations/claude-setup";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const setupDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith("cc-claude-setup-"));

describe("ClaudeSetup (with a fake claude CLI)", () => {
  const setup = new ClaudeSetup({ bin: FAKE, env: { PATH: process.env.PATH }, stepTimeoutMs: 10_000 });
  afterAll(() => setup.cancel());

  it("shows the sign-in URL, passes the code on and returns the token", async () => {
    const before = setupDirs().length;
    const { setupId, url } = await setup.start();
    expect(url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?code=true&client_id=abc&state=s{40}$/);
    const token = await setup.finish(setupId, "abc123");
    expect(token).toBe(`sk-ant-oat01-${Buffer.from("abc123").toString("hex")}${"A".repeat(24)}`);
    expect(setupDirs().length).toBe(before); // the throwaway HOME is gone
  });

  it("reports a rejected code without echoing the CLI's output", async () => {
    const { setupId } = await setup.start();
    await expect(setup.finish(setupId, "bad")).rejects.toThrow(/^Claude didn't accept that code; press Connect to try again$/);
  });

  it("a new start ends the earlier one; old ids and odd codes are refused", async () => {
    const first = await setup.start();
    const second = await setup.start();
    await expect(setup.finish(first.setupId, "abc")).rejects.toThrow(/expired/);
    await expect(setup.finish(second.setupId, "a\nb")).rejects.toThrow(/doesn't look like/);
    await setup.cancel(second.setupId);
  });

  it("fails cleanly when the CLI never shows a link", async () => {
    const broken = new ClaudeSetup({ bin: "/bin/false", env: { PATH: process.env.PATH }, stepTimeoutMs: 5_000 });
    await expect(broken.start()).rejects.toThrow(/didn't show a sign-in link/);
  });
});

describe.skipIf(!DB_URL)("Connect Claude API", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { claudeSetupBin: FAKE } });
  });
  afterAll(() => ctx.server.stop());

  it("saves the token encrypted and switches agents to Claude", async () => {
    const log = vi.spyOn(console, "log");
    const start = await ctx.api("/api/integrations/claude/setup", { method: "POST" });
    expect(start.status).toBe(200);
    expect(start.body.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
    const done = await ctx.api(`/api/integrations/claude/setup/${start.body.setupId}/code`, { method: "POST", json: { code: "xyz" } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, runner: "claude-code" });
    const token = `sk-ant-oat01-${Buffer.from("xyz").toString("hex")}`;
    expect(JSON.stringify(done.body)).not.toContain(token);
    expect(ctx.server.integrations.current().agent).toMatchObject({ runner: "claude-code", oauthToken: expect.stringContaining(token) });
    const { rows } = await ctx.server.store.pool.query("select * from integration_entries where kind = 'claude'");
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    const list = await ctx.api("/api/integrations");
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it("a wrong code saves nothing", async () => {
    await ctx.api("/api/integrations/claude/default", { method: "DELETE" });
    const start = await ctx.api("/api/integrations/claude/setup", { method: "POST" });
    const done = await ctx.api(`/api/integrations/claude/setup/${start.body.setupId}/code`, { method: "POST", json: { code: "bad" } });
    expect(done.status).toBe(400);
    expect(ctx.server.integrations.current().agent.oauthToken).toBeUndefined();
  });

  it("needs a signed-in caller", async () => {
    expect((await ctx.server.app.request("/api/integrations/claude/setup", { method: "POST" })).status).toBe(401);
  });
});
