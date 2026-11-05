import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DMSID_ALLOWED_EMAILS, dmsidAllows } from "../src/accounts/dmsid";
import { AuthService } from "../src/accounts/service";
import { loadConfig } from "../src/config";
import { base32Decode, hotp, totpStep } from "../src/accounts/totp";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

const FAST = { ln: 10, r: 8, p: 1 };
const ISSUER = "https://id.example.com";
const BASE = "https://cc.example.com";
const CALLBACK = `${BASE}/api/auth/dmsid/callback`;
const CLIENT_SECRET = "dmsid_client-secret-for-tests";
const DAVE = "dave@desktopmachineshop.com";
const PASSWORD = "daves-password-123";

describe("DMSid allow-list", () => {
  it("is Dave's address and nothing else", () => {
    expect(DMSID_ALLOWED_EMAILS).toEqual([DAVE]);
    expect(dmsidAllows(" Dave@DesktopMachineShop.com ")).toBe(true);
    expect(dmsidAllows("someone@desktopmachineshop.com")).toBe(false);
    expect(dmsidAllows("dave@desktopmachineshop.com.evil.example")).toBe(false);
  });
});

describe("DMSid configuration", () => {
  const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "a".repeat(20) };
  it("is off without the secret, and blank variables count as unset", () => {
    expect(loadConfig({ ...base, DMSID_ISSUER: "", DMSID_CLIENT_ID: "", DMSID_CLIENT_SECRET: "" }).dmsid).toBeUndefined();
    expect(loadConfig({ ...base, DMSID_CLIENT_SECRET: "s".repeat(20) }).dmsid).toBeUndefined(); // no PUBLIC_BASE_URL to come back to
  });
  it("defaults to DMSid and the command-centre client, coming back to PUBLIC_BASE_URL", () => {
    const c = loadConfig({ ...base, DMSID_ISSUER: "", DMSID_CLIENT_SECRET: "s".repeat(20), PUBLIC_BASE_URL: "https://cc.example/" });
    expect(c.dmsid).toEqual({
      issuer: "https://id.desktopmachineshop.com",
      clientId: "command-centre",
      clientSecret: "s".repeat(20),
      redirectUri: "https://cc.example/api/auth/dmsid/callback",
    });
  });
});

/** A stand-in for DMSid's token and key endpoints, signing ID tokens with its own RSA key. */
class FakeDmsId {
  readonly key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly kid = "test-key";
  /** What the next code redeemed says about the person, and any tampering to apply. */
  next: { email: string; verified: boolean; nonce?: string; aud?: string; iss?: string; exp?: number; signWith?: KeyObject } = { email: DAVE, verified: true };
  /** code -> the nonce and PKCE challenge from the authorize request. */
  readonly codes = new Map<string, { nonce: string; challenge: string }>();
  readonly tokenRequests: URLSearchParams[] = [];

  /** Plays DMSid's authorize step: a code for the request the app started. */
  authorize(location: string): { code: string; state: string } {
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oidc/authorize`);
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("command-centre");
    expect(q.get("redirect_uri")).toBe(CALLBACK);
    expect(q.get("code_challenge_method")).toBe("S256");
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")! });
    return { code, state: q.get("state")! };
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/oidc/jwks`) {
      const jwk = this.key.publicKey.export({ format: "jwk" });
      return Response.json({ keys: [{ ...jwk, kid: this.kid, use: "sig", alg: "RS256" }] });
    }
    if (url === `${ISSUER}/oidc/token`) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth !== `Basic ${Buffer.from(`command-centre:${CLIENT_SECRET}`).toString("base64")}`) return Response.json({ error: "invalid_client" }, { status: 401 });
      const body = new URLSearchParams(String(init?.body));
      this.tokenRequests.push(body);
      const issued = this.codes.get(body.get("code") ?? "");
      this.codes.delete(body.get("code") ?? "");
      const pkce = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
      if (!issued || pkce !== issued.challenge || body.get("redirect_uri") !== CALLBACK) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const n = this.next;
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: n.iss ?? ISSUER,
        aud: n.aud ?? "command-centre",
        sub: "sub-1",
        email: n.email,
        email_verified: n.verified,
        nonce: n.nonce ?? issued.nonce,
        iat: now,
        exp: n.exp ?? now + 300,
      };
      const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: this.kid, typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), n.signWith ?? this.key.privateKey).toString("base64url");
      return Response.json({ id_token: `${head}.${payload}.${sig}`, access_token: "at", token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

type Res = { status: number; location: string | null; cookies: string[]; body: any };

describe.skipIf(!DB_URL)("sign in with DMSid (integration)", () => {
  const dmsid = new FakeDmsId();
  let ctx: Awaited<ReturnType<typeof makeServer>>;

  /** A browser: keeps cookies across requests, as the real one does through the round trip. */
  const browser = () => {
    const jar = new Map<string, string>();
    const send = async (path: string, init: { method?: string; json?: unknown } = {}): Promise<Res> => {
      const headers = new Headers({ "x-forwarded-for": "198.51.100.7", "x-cc-request": "1" });
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      if (init.json !== undefined) headers.set("content-type", "application/json");
      const res = await ctx.server.app.request(path, {
        method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      });
      const cookies = res.headers.getSetCookie();
      for (const c of cookies) {
        const [pair] = c.split(";");
        const name = pair!.slice(0, pair!.indexOf("="));
        if (/Max-Age=0/i.test(c)) jar.delete(name);
        else jar.set(name, pair!.slice(pair!.indexOf("=") + 1));
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: res.status, location: res.headers.get("location"), cookies, body };
    };
    return { send, jar };
  };

  /** Start, let the fake DMSid answer, and come back. Returns the callback's response. */
  const roundTrip = async (b: ReturnType<typeof browser>, tamper?: (q: URLSearchParams) => void) => {
    const start = await b.send("/api/auth/dmsid");
    expect(start.status).toBe(302);
    const { code, state } = dmsid.authorize(start.location!);
    const q = new URLSearchParams({ code, state, iss: ISSUER });
    tamper?.(q);
    return b.send(`/api/auth/dmsid/callback?${q}`);
  };

  const hasSession = (r: Res) => r.cookies.some((c) => /^(__Host-)?cc_session=[^;]+/.test(c) && !/Max-Age=0/i.test(c));

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({
      env: { DMSID_ISSUER: ISSUER, DMSID_CLIENT_SECRET: CLIENT_SECRET, PUBLIC_BASE_URL: BASE },
      overrides: { scrypt: FAST, dmsidFetch: dmsid.fetch },
    });
    const setup = await ctx.server.app.request("/api/auth/setup", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", "x-forwarded-for": "198.51.100.8" },
      body: JSON.stringify({ email: DAVE, name: "Dave", password: PASSWORD }),
    });
    expect(setup.status).toBe(201);
    // A second real user, so the allow-list (not a missing account) is what stops them.
    await new AuthService(ctx.server.auth.store.pool, { scrypt: FAST }).createUser({ email: "va@desktopmachineshop.com", name: "VA", password: PASSWORD });
  });
  afterAll(async () => ctx?.server.stop());

  it("is offered on the sign-in screen when configured", async () => {
    const status = await browser().send("/api/auth/status");
    expect(status.body).toEqual({ setupRequired: false, dmsid: true, dmsidCodeRequired: false });
  });

  it("starts the code flow with PKCE, state and nonce, bound to this browser", async () => {
    const b = browser();
    const start = await b.send("/api/auth/dmsid");
    const q = new URL(start.location!).searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("openid email");
    expect(q.get("state")).toMatch(/^[\w-]{40,}$/);
    expect(q.get("nonce")).toMatch(/^[\w-]{40,}$/);
    expect(q.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    const flow = start.cookies.find((c) => c.startsWith("cc_dmsid_flow="))!;
    expect(flow).toContain(q.get("state")!);
    expect(flow).toMatch(/HttpOnly/i);
    expect(flow).toMatch(/Path=\/api\/auth\/dmsid/);
  });

  it("signs Dave in with his confirmed address", async () => {
    dmsid.next = { email: DAVE, verified: true };
    const b = browser();
    const back = await roundTrip(b);
    expect(back.status).toBe(302);
    expect(back.location).toBe("/");
    expect(hasSession(back)).toBe(true);
    const me = await b.send("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(DAVE);
    // The flow cookie is gone and the state can't be used again.
    expect(b.jar.has("cc_dmsid_flow")).toBe(false);
  });

  it("refuses any other address, even a confirmed one, without a session", async () => {
    for (const next of [
      { email: "va@desktopmachineshop.com", verified: true },
      { email: "someone@desktopmachineshop.com", verified: true },
      { email: "dave@example.com", verified: true },
      // Anyone can type Dave's address into a new DMSid; only a confirmed one counts.
      { email: DAVE, verified: false },
    ]) {
      dmsid.next = next;
      const back = await roundTrip(browser());
      expect(back.location).toBe("/?signin=dmsid-refused");
      expect(hasSession(back)).toBe(false);
    }
  });

  it("refuses a DMSid refusal, a forged state and a replayed callback", async () => {
    dmsid.next = { email: DAVE, verified: true };
    const denied = await roundTrip(browser(), (q) => (q.delete("code"), q.set("error", "access_denied")));
    expect(denied.location).toBe("/?signin=dmsid-refused");

    // A callback this browser didn't start (login CSRF): no flow cookie.
    const b = browser();
    const start = await b.send("/api/auth/dmsid");
    const { code, state } = dmsid.authorize(start.location!);
    const stranger = await browser().send(`/api/auth/dmsid/callback?${new URLSearchParams({ code, state })}`);
    expect(stranger.location).toBe("/?signin=dmsid-failed");
    expect(hasSession(stranger)).toBe(false);

    // The right browser, but a different state.
    const wrong = await roundTrip(browser(), (q) => q.set("state", "forged-state"));
    expect(wrong.location).toBe("/?signin=dmsid-failed");

    // Another issuer in the response.
    const otherIss = await roundTrip(browser(), (q) => q.set("iss", "https://evil.example"));
    expect(otherIss.location).toBe("/?signin=dmsid-failed");
  });

  it("checks the ID token: signature, issuer, audience, expiry and nonce", async () => {
    const forger = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const tamper of [
      { signWith: forger.privateKey },
      { iss: "https://evil.example" },
      { aud: "openv" },
      { exp: Math.floor(Date.now() / 1000) - 3600 },
      { nonce: "someone-elses-nonce" },
    ]) {
      dmsid.next = { email: DAVE, verified: true, ...tamper };
      const back = await roundTrip(browser());
      expect(back.location, JSON.stringify(Object.keys(tamper))).toBe("/?signin=dmsid-failed");
      expect(hasSession(back)).toBe(false);
    }
    dmsid.next = { email: DAVE, verified: true };
  });

  it("still asks for the authenticator code when two-factor is on", async () => {
    // Turn two-factor on for Dave, from a password session.
    const pw = browser();
    expect((await pw.send("/api/auth/login", { json: { email: DAVE, password: PASSWORD } })).status).toBe(200);
    const { secret } = (await pw.send("/api/auth/totp/setup", { json: {} })).body;
    const code = (offsetSteps: number) => hotp(base32Decode(secret), totpStep(Date.now()) + offsetSteps);
    expect((await pw.send("/api/auth/totp/enable", { json: { code: code(-1) } })).status).toBe(200);

    dmsid.next = { email: DAVE, verified: true };
    const b = browser();
    const back = await roundTrip(b);
    expect(back.location).toBe("/?signin=dmsid-code");
    expect(hasSession(back)).toBe(false);
    expect((await b.send("/api/auth/status")).body.dmsidCodeRequired).toBe(true);
    expect((await b.send("/api/auth/me")).status).toBe(401);

    const wrong = await b.send("/api/auth/dmsid/totp", { json: { code: "000000" } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.totpRequired).toBe(true);
    // Another browser can't use the ticket.
    expect((await browser().send("/api/auth/dmsid/totp", { json: { code: code(0) } })).body.expired).toBe(true);

    const ok = await b.send("/api/auth/dmsid/totp", { json: { code: code(0) } });
    expect(ok.status).toBe(200);
    expect(hasSession({ status: ok.status, location: null, cookies: ok.cookies, body: null })).toBe(true);
    expect((await b.send("/api/auth/me")).body.user.email).toBe(DAVE);
    // The ticket is used up.
    expect((await b.send("/api/auth/dmsid/totp", { json: { code: code(1) } })).body.expired).toBe(true);
  });

  it("refuses without a Command Centre user for the address", async () => {
    // Dave is the only allowed address and he exists, so take him away for this check.
    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("update users set email = 'renamed@example.com' where email = $1", [DAVE]);
    try {
      dmsid.next = { email: DAVE, verified: true };
      const back = await roundTrip(browser());
      expect(back.location).toBe("/?signin=dmsid-refused");
      expect(hasSession(back)).toBe(false);
    } finally {
      await client.query("update users set email = $1 where email = 'renamed@example.com'", [DAVE]);
      await client.end();
    }
  });

  it("never sends the client secret anywhere but DMSid's token endpoint, nor to the browser", async () => {
    const b = browser();
    for (const path of ["/api/auth/status", "/api/auth/dmsid"]) {
      const r = await b.send(path);
      expect(JSON.stringify(r)).not.toContain(CLIENT_SECRET);
    }
    for (const body of dmsid.tokenRequests) expect(body.toString()).not.toContain(CLIENT_SECRET);
  });
});

describe.skipIf(!DB_URL)("without DMSid configured (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { scrypt: FAST } });
  });
  afterAll(async () => ctx?.server.stop());

  it("isn't offered, and its routes don't exist", async () => {
    const status = await ctx.server.app.request("/api/auth/status");
    expect(await status.json()).toMatchObject({ dmsid: false, dmsidCodeRequired: false });
    expect((await ctx.server.app.request("/api/auth/dmsid")).status).toBe(404);
    expect((await ctx.server.app.request("/api/auth/dmsid/callback?code=x&state=y")).status).toBe(404);
  });
});
