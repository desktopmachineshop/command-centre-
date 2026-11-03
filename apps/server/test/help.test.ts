import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Principal } from "../src/accounts/http";
import { loadConfig } from "../src/config";
import { HELP_TOKEN_TTL_SECONDS, helpRoutes, signHelpToken } from "../src/http/help";

const SECRET = "s".repeat(40);
const DOCS = "https://command-centre.opend.app";
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

function appWith(principal: Principal, cfg: Parameters<typeof helpRoutes>[0]) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  app.route("/api", helpRoutes(cfg));
  return app;
}
const user = { kind: "user", sessionId: "s1", user: { email: "dave@example.com" } } as unknown as Principal;

describe("help embed tokens", () => {
  it("signs an HS256 token OpenD accepts: email, aud, iat, exp ≤ 600 s, optional org", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    const token = signHelpToken({ docsUrl: DOCS, app: "command-centre", embedSecret: SECRET, org: "dms" }, "dave@example.com", now);
    const [h, b, sig] = token.split(".");
    expect(decode(h!)).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = decode(b!);
    expect(claims).toEqual({ email: "dave@example.com", org: "dms", aud: DOCS, iat: now / 1000, exp: now / 1000 + HELP_TOKEN_TTL_SECONDS });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(sig).toBe(createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url"));

    const noOrg = decode(signHelpToken({ docsUrl: DOCS, app: "x", embedSecret: SECRET }, "a@b.c", now).split(".")[1]!);
    expect(noOrg).not.toHaveProperty("org");
  });

  it("serves the config and a no-store token to a signed-in user", async () => {
    const app = appWith(user, { docsUrl: DOCS, app: "command-centre", embedSecret: SECRET });
    expect(await (await app.request("/api/help/config")).json()).toEqual({ docsUrl: DOCS, app: "command-centre", embed: true });
    const res = await app.request("/api/help/token");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(decode((await res.text()).split(".")[1]!).email).toBe("dave@example.com");
  });

  it("refuses a token without a secret, or for the admin token", async () => {
    const off = appWith(user, { docsUrl: DOCS, app: "command-centre" });
    expect(await (await off.request("/api/help/config")).json()).toMatchObject({ embed: false });
    expect((await off.request("/api/help/token")).status).toBe(404);
    const admin = appWith({ kind: "token" }, { docsUrl: DOCS, app: "command-centre", embedSecret: SECRET });
    expect((await admin.request("/api/help/token")).status).toBe(400);
  });

  it("reads the OPEND_* settings, defaulting to the Command Centre docs site", () => {
    const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "a".repeat(20) };
    expect(loadConfig(base).help).toEqual({ docsUrl: DOCS, app: "command-centre", embedSecret: undefined, org: undefined });
    expect(loadConfig({ ...base, OPEND_DOCS_URL: "https://help.example.com/", OPEND_EMBED_SECRET: SECRET, OPEND_ORG: "dms" }).help).toEqual({
      docsUrl: "https://help.example.com",
      app: "command-centre",
      embedSecret: SECRET,
      org: "dms",
    });
    expect(() => loadConfig({ ...base, OPEND_EMBED_SECRET: "short" })).toThrow(/OPEND_EMBED_SECRET/);
  });
});
