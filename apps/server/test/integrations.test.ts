import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretBox } from "../src/integrations";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

describe("SecretBox", () => {
  const key = "a".repeat(64);
  it("round-trips and hides the plaintext", () => {
    const box = SecretBox.fromKey(key);
    const sealed = box.seal({ apiKey: "sk-very-secret-value" });
    expect(sealed).not.toContain("sk-very-secret");
    expect(box.open(sealed)).toEqual({ apiKey: "sk-very-secret-value" });
  });

  it("rejects a tampered blob and the wrong key", () => {
    const sealed = SecretBox.fromKey(key).seal({ a: "b" });
    const parts = sealed.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 1;
    expect(() => SecretBox.fromKey(key).open([...parts.slice(0, 3), ct.toString("base64")].join(":"))).toThrow(/can't be decrypted/);
    expect(() => SecretBox.fromKey("b".repeat(64)).open(sealed)).toThrow(/can't be decrypted/);
  });

  it("binds a blob to its entry and refuses short tags", () => {
    const box = SecretBox.fromKey(key);
    const sealed = box.seal({ apiKey: "k" }, "openai/default");
    expect(box.open(sealed, "openai/default")).toEqual({ apiKey: "k" });
    expect(() => box.open(sealed, "odoo/default")).toThrow(/can't be decrypted/);
    const [v, iv, tag, ct] = sealed.split(":");
    const short = Buffer.from(tag!, "base64").subarray(0, 4).toString("base64");
    expect(() => box.open([v, iv, short, ct].join(":"), "openai/default")).toThrow(/can't be decrypted/);
  });

  it("generates a private key file once and reuses it", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "cc-key-")), "credentials.key");
    const a = await SecretBox.load({ keyFile });
    const b = await SecretBox.load({ keyFile });
    expect(b.open(a.seal({ x: "y" }))).toEqual({ x: "y" });
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!DB_URL)("Accounts page API", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const SECRET = "odoo-api-key-that-must-never-leak-0042";

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { OPENAI_API_KEY: "sk-from-railway-env-9999" } });
  });
  afterAll(() => ctx.server.stop());

  it("lists the catalogue, Railway values (masked) and bootstrap settings", async () => {
    const res = await ctx.api("/api/integrations");
    expect(res.status).toBe(200);
    expect(res.body.kinds.map((k: { kind: string }) => k.kind)).toEqual(expect.arrayContaining(["claude", "odoo", "email", "google", "instagram", "x"]));
    const openai = res.body.entries.find((e: { kind: string }) => e.kind === "openai");
    expect(openai).toMatchObject({ source: "railway", secrets: { apiKey: "••••9999" } });
    expect(JSON.stringify(res.body)).not.toContain("sk-from-railway-env");
    expect(res.body.railwayOnly.find((r: { name: string }) => r.name === "ADMIN_TOKEN")).toBeTruthy();
  });

  it("saves Odoo encrypted, applies it live, and never returns the key", async () => {
    expect(ctx.server.integrations.current().odoo).toBeUndefined();
    const res = await ctx.api("/api/integrations/odoo", {
      method: "PUT",
      json: { data: { url: "https://dms.odoo.com/", db: "dms", username: "dave@example.com" }, secrets: { apiKey: SECRET } },
    });
    expect(res.status).toBe(200);
    expect(res.body.reloaded).toContain("odoo");
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(ctx.server.integrations.current().odoo).toMatchObject({ url: "https://dms.odoo.com", db: "dms", apiKey: SECRET });

    const list = await ctx.api("/api/integrations");
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(list.body.entries.find((e: { kind: string }) => e.kind === "odoo")).toMatchObject({ source: "app", secrets: { apiKey: "••••0042" } });

    const { rows } = await ctx.server.store.pool.query("select * from integration_entries where kind = 'odoo'");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const audit = await ctx.server.store.pool.query("select actor, action from integration_audit where kind = 'odoo'");
    expect(audit.rows).toEqual([{ actor: "admin token", action: "created" }]);
  });

  it("keeps a stored secret when the field is left blank", async () => {
    const res = await ctx.api("/api/integrations/odoo", { method: "PUT", json: { data: { db: "dms2" }, secrets: { apiKey: "" } } });
    expect(res.status).toBe(200);
    expect(ctx.server.integrations.current().odoo).toMatchObject({ db: "dms2", apiKey: SECRET });
  });

  it("rejects invalid input without saving", async () => {
    const bad = await ctx.api("/api/integrations/odoo", { method: "PUT", json: { data: { url: "not a url" } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Odoo URL must be/);
    expect(ctx.server.integrations.current().odoo?.db).toBe("dms2");

    const vertical = await ctx.api("/api/integrations/discord/dms-discord", { method: "PUT", json: { data: { vertical: "nope" }, secrets: { botToken: "x".repeat(40) } } });
    expect(vertical.status).toBe(400);
    expect(vertical.body.error).toMatch(/doesn't exist/);

    expect((await ctx.api("/api/integrations/nonsense", { method: "PUT", json: {} })).status).toBe(404);
    expect((await ctx.api("/api/integrations/email/Bad Id!", { method: "PUT", json: {} })).status).toBe(400);
  });

  it("moves a Railway value into the app", async () => {
    const res = await ctx.api("/api/integrations/openai/default/import", { method: "POST" });
    expect(res.status).toBe(200);
    const list = await ctx.api("/api/integrations");
    const openai = list.body.entries.filter((e: { kind: string }) => e.kind === "openai");
    expect(openai).toHaveLength(1);
    expect(openai[0].source).toBe("app");
    expect((await ctx.api("/api/integrations/openai/default/import", { method: "POST" })).status).toBe(409);
  });

  it("disconnects and falls back to the env config", async () => {
    const res = await ctx.api("/api/integrations/odoo/default", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(ctx.server.integrations.current().odoo).toBeUndefined();
    expect((await ctx.api("/api/integrations/odoo/default", { method: "DELETE" })).status).toBe(404);
  });

  it("keeps social account names unique across platforms", async () => {
    const put = (kind: string) => ctx.api(`/api/integrations/${kind}/shop`, { method: "PUT", json: { data: { vertical: "dms" }, secrets: { accessToken: "t".repeat(20), accessTokenSecret: "s".repeat(20), botToken: "b".repeat(60) } } });
    const first = await ctx.api("/api/integrations/discord/shop", { method: "PUT", json: { data: { vertical: "dms" }, secrets: { botToken: "b".repeat(60) } } });
    expect(first.status).not.toBe(409);
    const clash = await put("x");
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already used by a Discord account/);
    await ctx.server.store.pool.query("delete from integration_entries where id = 'shop'");
  });

  it("refuses options that aren't a JSON object, control characters, and huge bodies", async () => {
    const options = await ctx.api("/api/integrations/discord/d1", { method: "PUT", json: { data: { vertical: "dms", options: "null" }, secrets: { botToken: "b".repeat(60) } } });
    expect(options.status).toBe(400);
    expect(options.body.error).toMatch(/must be a JSON object/);
    const nul = await ctx.api("/api/integrations/odoo", { method: "PUT", json: { data: { url: "https://x.odoo.com", db: "a\u0000b", username: "d@example.com" }, secrets: { apiKey: "k" } } });
    expect(nul.status).toBe(400);
    expect(JSON.stringify(nul.body)).not.toContain("x.odoo.com");
    const huge = await ctx.api("/api/integrations/odoo", { method: "PUT", json: { data: { db: "x".repeat(100_000) } } });
    expect(huge.status).toBe(413);
  });

  it("clearing the Claude token doesn't fall back to Railway's", async () => {
    await ctx.api("/api/integrations/claude", { method: "PUT", json: { data: { runner: "echo" }, secrets: { oauthToken: "sk-ant-oat01-abcdefghijklmnop" } } });
    await ctx.api("/api/integrations/claude", { method: "PUT", json: { secrets: { oauthToken: null } } });
    expect(ctx.server.integrations.current().agent.oauthToken).toBeUndefined();
  });

  it("needs credentials", async () => {
    const res = await ctx.server.app.request("/api/integrations");
    expect(res.status).toBe(401);
  });
});
