import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "../src/accounts/service";
import { base32Decode, hotp, totpStep } from "../src/accounts/totp";
import { type CliIo, runCli } from "../src/cli";
import { ADMIN, DB_URL, makeServer, resetDatabase, serveServer } from "./helpers";

/** Cheap hashing so the suite stays quick; the unit tests cover the production cost. */
const FAST = { ln: 10, r: 8, p: 1 };
const EMAIL = "Dave@Example.com";
const PASSWORD = "first-password-123";

type Res = { status: number; body: any; cookies: string[]; headers: Headers };

describe.skipIf(!DB_URL)("auth (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let ipCounter = 0;
  /** A fresh client IP, so tests don't share rate-limit state. */
  const freshIp = () => `203.0.113.${++ipCounter}`;

  /** A request without the admin token unless given; `cookie` is sent as-is. */
  const req = async (
    path: string,
    init: { method?: string; json?: unknown; cookie?: string; headers?: Record<string, string>; csrf?: boolean; ip?: string } = {},
  ): Promise<Res> => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.csrf !== false) headers.set("x-cc-request", "1");
    headers.set("x-forwarded-for", init.ip ?? "198.51.100.1");
    const res = await ctx.server.app.request(path, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookies: res.headers.getSetCookie(), headers: res.headers };
  };

  /** The `name=value` part of the session cookie, for sending back. */
  const cookieOf = (r: Res) => {
    const c = r.cookies.find((s) => /^(__Host-)?cc_session=/.test(s));
    if (!c) throw new Error(`no session cookie in ${JSON.stringify(r.cookies)}`);
    return c.split(";")[0]!;
  };

  const login = (email: string, password: string, extra: { totp?: string; ip?: string; headers?: Record<string, string> } = {}) =>
    req("/api/auth/login", { json: { email, password, totp: extra.totp }, ip: extra.ip, headers: extra.headers });

  const codeAt = (secret: string, ms: number) => hotp(base32Decode(secret), totpStep(ms));

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { scrypt: FAST } });
  });
  afterAll(async () => ctx?.server.stop());

  describe("first-run setup", () => {
    it("reports that setup is needed and nothing else", async () => {
      expect((await req("/api/auth/status")).body).toEqual({ setupRequired: true });
    });

    it("refuses setup without the admin token", async () => {
      const body = { email: EMAIL, name: "Dave", password: PASSWORD };
      expect((await req("/api/auth/setup", { json: body })).status).toBe(401);
      expect((await req("/api/auth/setup", { json: body, headers: { authorization: "Bearer wrong-token-wrong-token" } })).status).toBe(401);
      expect((await req("/api/auth/status")).body.setupRequired).toBe(true);
    });

    it("validates the new user", async () => {
      const auth = { authorization: `Bearer ${ADMIN}` };
      expect((await req("/api/auth/setup", { json: { email: "not-an-email", name: "Dave", password: PASSWORD }, headers: auth })).status).toBe(400);
      const short = await req("/api/auth/setup", { json: { email: EMAIL, name: "Dave", password: "short" }, headers: auth });
      expect(short.status).toBe(400);
      expect(short.body.error).toMatch(/at least 10/);
    });

    it("creates the first admin with the admin token and signs them in", async () => {
      const res = await req("/api/auth/setup", {
        json: { email: EMAIL, name: "Dave", password: PASSWORD },
        headers: { authorization: `Bearer ${ADMIN}` },
        csrf: false, // Bearer requests are exempt from the CSRF header
      });
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ email: "dave@example.com", name: "Dave", role: "admin", totpEnabled: false });
      expect(res.body.user.passwordHash).toBeUndefined();
      const me = await req("/api/auth/me", { cookie: cookieOf(res) });
      expect(me.body).toMatchObject({ via: "session", user: { email: "dave@example.com" } });
      expect((await req("/api/auth/status")).body.setupRequired).toBe(false);
    });

    it("refuses setup once a user exists, even with the admin token", async () => {
      const res = await req("/api/auth/setup", {
        json: { email: "mallory@example.com", name: "M", password: "another-password" },
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      expect(res.status).toBe(409);
      const { rows } = await ctx.server.auth.store.pool.query("select email from users");
      expect(rows).toEqual([{ email: "dave@example.com" }]);
    });
  });

  describe("login", () => {
    it("signs in with any capitalisation of the email", async () => {
      const res = await login("  DAVE@example.COM ", PASSWORD);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("dave@example.com");
      expect(res.body.user.lastLoginAt).toBeTruthy();
    });

    it("gives the same generic error for a bad email and a bad password", async () => {
      const badPassword = await login(EMAIL, "wrong-password-1");
      const badEmail = await login("nobody@example.com", PASSWORD);
      expect(badPassword.status).toBe(401);
      expect(badEmail.status).toBe(401);
      expect(badPassword.body).toEqual({ error: "Incorrect email or password" });
      expect(badEmail.body).toEqual(badPassword.body);
      expect(badPassword.cookies).toEqual([]);
      // Reset the failure count this added.
      expect((await login(EMAIL, PASSWORD)).status).toBe(200);
    });

    it("takes about as long for an unknown email as for a wrong password", async () => {
      // A separate service at production-like cost, so the hash dominates the timing.
      const auth = new AuthService(ctx.server.auth.store.pool, { scrypt: { ln: 14, r: 8, p: 1 } });
      await auth.createUser({ email: "timing@example.com", name: "T", password: "timing-password-1" });
      await auth.warm();
      const time = async (email: string) => {
        const runs: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t = performance.now();
          const r = await auth.login({ email, password: "wrong-password-x", ip: freshIp(), userAgent: null });
          runs.push(performance.now() - t);
          expect(r).toEqual({ ok: false, reason: "invalid" });
          await auth.store.pool.query("update users set failed_attempts = 0, locked_until = null");
        }
        return runs.sort((a, b) => a - b)[2]!;
      };
      const known = await time("timing@example.com");
      const unknown = await time("nobody-timing@example.com");
      expect(unknown / known).toBeGreaterThan(0.5);
      expect(unknown / known).toBeLessThan(2);
      await auth.store.pool.query("delete from users where email = 'timing@example.com'");
    });

    it("requires the CSRF header (or a same-origin Origin) on login", async () => {
      expect((await req("/api/auth/login", { json: { email: EMAIL, password: PASSWORD }, csrf: false })).status).toBe(403);
      const sameOrigin = await req("/api/auth/login", {
        json: { email: EMAIL, password: PASSWORD },
        csrf: false,
        headers: { host: "cc.example.com", origin: "https://cc.example.com" },
      });
      expect(sameOrigin.status).toBe(200);
      const crossSite = await req("/api/auth/login", {
        json: { email: EMAIL, password: PASSWORD },
        csrf: false,
        headers: { host: "cc.example.com", origin: "https://evil.example" },
      });
      expect(crossSite.status).toBe(403);
    });
  });

  describe("session cookie", () => {
    it("is HttpOnly, SameSite=Lax and lasts 30 days on plain http", async () => {
      const res = await login(EMAIL, PASSWORD);
      const cookie = res.cookies[0]!;
      expect(cookie).toMatch(/^cc_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain(`Max-Age=${30 * 24 * 3600}`);
      expect(cookie).not.toContain("Secure");
    });

    it("is __Host- prefixed and Secure behind an https proxy", async () => {
      const proxied = { "x-forwarded-proto": "https" };
      const res = await login(EMAIL, PASSWORD, { headers: proxied });
      const cookie = res.cookies[0]!;
      expect(cookie).toMatch(/^__Host-cc_session=/);
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Domain");

      expect((await req("/api/tasks", { cookie: cookieOf(res), headers: proxied })).status).toBe(200);
      // On https only the __Host- cookie counts, so a sibling site can't plant a plain one.
      const plain = cookieOf(res).replace(/^__Host-/, "");
      expect((await req("/api/tasks", { cookie: plain, headers: proxied })).status).toBe(401);
    });

    it("stores only the token's hash", async () => {
      const res = await login(EMAIL, PASSWORD);
      const token = cookieOf(res).split("=")[1]!;
      const { rows } = await ctx.server.auth.store.pool.query("select id from sessions");
      expect(rows.map((r) => r.id)).not.toContain(token);
      expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.id))).toBe(true);
    });
  });

  describe("API access", () => {
    let cookie: string;
    beforeAll(async () => {
      cookie = cookieOf(await login(EMAIL, PASSWORD));
    });

    it("accepts a session cookie or the admin Bearer token, and nothing else", async () => {
      expect((await req("/api/tasks")).status).toBe(401);
      expect((await req("/api/tasks", { cookie })).status).toBe(200);
      expect((await req("/api/tasks", { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200);
      expect((await req("/api/tasks", { cookie: "cc_session=forged" })).status).toBe(401);
      // A wrong Bearer token is refused even alongside a good cookie.
      expect((await req("/api/tasks", { cookie, headers: { authorization: "Bearer nope" } })).status).toBe(401);
      expect((await req("/api/auth/me", { headers: { authorization: `Bearer ${ADMIN}` } })).body).toEqual({ via: "token", user: null });
    });

    it("enforces CSRF on cookie writes but not on Bearer writes", async () => {
      const chat = { text: "csrf check" };
      expect((await req("/api/chat", { json: chat, cookie, csrf: false })).status).toBe(403);
      expect((await req("/api/chat", { json: chat, cookie, csrf: false, headers: { host: "cc.test", origin: "https://other.test" } })).status).toBe(403);
      expect((await req("/api/chat", { json: chat, cookie, csrf: false, headers: { host: "cc.test", origin: "https://cc.test" } })).status).toBe(201);
      expect((await req("/api/chat", { json: chat, cookie })).status).toBe(201);
      expect((await req("/api/chat", { json: chat, csrf: false, headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(201);
      // Reads don't need it.
      expect((await req("/api/tasks", { cookie, csrf: false })).status).toBe(200);
      await ctx.queue.drain();
    });

    it("keeps webhooks on their own secret and MCP on the admin token", async () => {
      expect((await req("/api/ingress/webhook/dms", { json: {}, csrf: false })).status).toBe(401);
      const mcp = await req("/mcp/brain", { json: { jsonrpc: "2.0", id: 1, method: "tools/list" }, cookie });
      expect(mcp.status).toBe(401);
    });
  });

  describe("sessions", () => {
    it("expire, and slide forward while used", async () => {
      const res = await login(EMAIL, PASSWORD);
      const cookie = cookieOf(res);
      const id = (await req("/api/auth/me", { cookie })).body.sessionId;
      const pool = ctx.server.auth.store.pool;

      await pool.query("update sessions set last_seen_at = now() - interval '2 minutes', expires_at = now() + interval '1 day' where id = $1", [id]);
      const slid = await req("/api/tasks", { cookie });
      expect(slid.status).toBe(200);
      expect(slid.cookies[0]).toMatch(/^cc_session=.*Max-Age=2592000/);
      const { rows } = await pool.query("select expires_at from sessions where id = $1", [id]);
      expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

      await pool.query("update sessions set expires_at = now() - interval '1 second' where id = $1", [id]);
      const expired = await req("/api/tasks", { cookie });
      expect(expired.status).toBe(401);
      expect(expired.cookies[0]).toMatch(/^cc_session=;.*Max-Age=0/);
    });

    it("lists devices and signs out another one", async () => {
      const phone = cookieOf(await login(EMAIL, PASSWORD, { headers: { "user-agent": "iPhone Safari" } }));
      const pc = cookieOf(await login(EMAIL, PASSWORD, { headers: { "user-agent": "Windows Edge" } }));
      const list = (await req("/api/auth/sessions", { cookie: phone })).body as any[];
      const current = list.find((s) => s.current);
      expect(current.userAgent).toBe("iPhone Safari");
      expect(current.userId).toBeUndefined();
      const pcSession = list.find((s) => s.userAgent === "Windows Edge");
      expect(pcSession).toBeTruthy();

      expect((await req(`/api/auth/sessions/${pcSession.id}`, { method: "DELETE", cookie: phone, csrf: false })).status).toBe(403);
      expect((await req(`/api/auth/sessions/${pcSession.id}`, { method: "DELETE", cookie: phone })).status).toBe(200);
      expect((await req("/api/tasks", { cookie: pc })).status).toBe(401);
      expect((await req("/api/tasks", { cookie: phone })).status).toBe(200);
      expect((await req("/api/auth/sessions/does-not-exist", { method: "DELETE", cookie: phone })).status).toBe(404);
    });

    it("signs out with logout", async () => {
      const cookie = cookieOf(await login(EMAIL, PASSWORD));
      const out = await req("/api/auth/logout", { method: "POST", cookie });
      expect(out.status).toBe(200);
      expect(out.cookies[0]).toMatch(/Max-Age=0/);
      expect((await req("/api/tasks", { cookie })).status).toBe(401);
    });

    it("changing the password needs the current one and signs out every other device", async () => {
      const keep = cookieOf(await login(EMAIL, PASSWORD));
      const other = cookieOf(await login(EMAIL, PASSWORD));
      const wrong = await req("/api/auth/password", { json: { currentPassword: "not-it-at-all", newPassword: "second-password-456" }, cookie: keep });
      expect(wrong.status).toBe(400);
      expect((await req("/api/auth/password", { json: { currentPassword: PASSWORD, newPassword: "short" }, cookie: keep })).status).toBe(400);

      const ok = await req("/api/auth/password", { json: { currentPassword: PASSWORD, newPassword: "second-password-456" }, cookie: keep });
      expect(ok.status).toBe(200);
      expect(ok.body.revokedSessions).toBeGreaterThanOrEqual(1);
      expect((await req("/api/tasks", { cookie: other })).status).toBe(401);
      expect((await req("/api/tasks", { cookie: keep })).status).toBe(200);
      expect((await login(EMAIL, PASSWORD)).status).toBe(401);
      expect((await login(EMAIL, "second-password-456")).status).toBe(200);
      // Back to the original for the rest of the suite.
      await req("/api/auth/password", { json: { currentPassword: "second-password-456", newPassword: PASSWORD }, cookie: keep });
    });

    it("refuses account changes with the admin token, which has no account", async () => {
      const res = await req("/api/auth/password", { json: { currentPassword: "x", newPassword: "y" }, headers: { authorization: `Bearer ${ADMIN}` } });
      expect(res.status).toBe(400);
    });
  });

  describe("lockout and rate limiting", () => {
    const pool = () => ctx.server.auth.store.pool;
    const unlock = () => pool().query("update users set failed_attempts = 0, locked_until = null");

    it("locks an account after five failures, even against the right password, then lets it in once the lock passes", async () => {
      for (let i = 0; i < 5; i++) expect((await login(EMAIL, `wrong-${i}-password`, { ip: freshIp() })).status).toBe(401);
      const locked = await login(EMAIL, PASSWORD, { ip: freshIp() });
      expect(locked.status).toBe(429);
      expect(locked.body).toEqual({ error: "Too many attempts. Try again later." });
      expect(Number(locked.headers.get("retry-after"))).toBeGreaterThanOrEqual(14);

      // Each further failure doubles the lock.
      await pool().query("update users set locked_until = now() - interval '1 second'");
      await login(EMAIL, "wrong-again-password", { ip: freshIp() });
      const { rows } = await pool().query("select failed_attempts, extract(epoch from locked_until - now()) as secs from users");
      expect(rows[0].failed_attempts).toBe(6);
      expect(Number(rows[0].secs)).toBeGreaterThan(25);
      expect(Number(rows[0].secs)).toBeLessThanOrEqual(30);

      await pool().query("update users set locked_until = now() - interval '1 second'");
      expect((await login(EMAIL, PASSWORD, { ip: freshIp() })).status).toBe(200);
      const after = await pool().query("select failed_attempts, locked_until from users");
      expect(after.rows[0]).toEqual({ failed_attempts: 0, locked_until: null });
    });

    it("locks an unknown email the same way, so a lockout doesn't reveal which accounts exist", async () => {
      for (let i = 0; i < 5; i++) expect((await login("ghost@example.com", `wrong-${i}-password`, { ip: freshIp() })).status).toBe(401);
      const res = await login("ghost@example.com", PASSWORD, { ip: freshIp() });
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: "Too many attempts. Try again later." });
    });

    it("rate-limits an IP that keeps failing across many accounts", async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) expect((await login(`spray${i}@example.com`, "wrong-password-z", { ip })).status).toBe(401);
      expect((await login("spray-next@example.com", "wrong-password-z", { ip })).status).toBe(429);
      // Blocked even with the right password, but only from that IP.
      expect((await login(EMAIL, PASSWORD, { ip })).status).toBe(429);
      expect((await login(EMAIL, PASSWORD, { ip: freshIp() })).status).toBe(200);
      await unlock();
    });

    it("takes the client IP from the proxy's end of X-Forwarded-For, so a spoofed prefix doesn't dodge the limit", async () => {
      const real = freshIp();
      for (let i = 0; i < 20; i++) {
        expect((await login(`spoof${i}@example.com`, "wrong-password-z", { ip: `10.9.${i}.1, ${real}` })).status).toBe(401);
      }
      expect((await login(EMAIL, PASSWORD, { ip: `10.10.10.10, ${real}` })).status).toBe(429);
      await unlock();
    });

    it("serialises parallel guesses so they can't all race past the lock", async () => {
      await unlock();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => login(EMAIL, `parallel-${i}-wrong`, { ip: freshIp() })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(3);
      await unlock();
    });

    it("throttles bad admin tokens on setup per IP", async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        await req("/api/auth/setup", { json: {}, ip, headers: { authorization: `Bearer guess-${i}-guess-guess` } });
      }
      const res = await req("/api/auth/setup", { json: {}, ip, headers: { authorization: `Bearer ${ADMIN}` } });
      expect(res.status).toBe(429);
    });
  });

  describe("two-factor (TOTP)", () => {
    let cookie: string;
    let secret: string;
    let recoveryCodes: string[];

    beforeAll(async () => {
      cookie = cookieOf(await login(EMAIL, PASSWORD, { ip: freshIp() }));
    });

    it("sets up with a secret and otpauth URL, and enables only with a valid code", async () => {
      const setup = await req("/api/auth/totp/setup", { method: "POST", cookie });
      expect(setup.status).toBe(200);
      secret = setup.body.secret;
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Command%20Centre%3Adave%40example\.com\?secret=/);

      // Not enforced until enabled.
      expect((await login(EMAIL, PASSWORD, { ip: freshIp() })).status).toBe(200);

      expect((await req("/api/auth/totp/enable", { json: { code: "000000" }, cookie })).status).toBe(400);
      const enabled = await req("/api/auth/totp/enable", { json: { code: codeAt(secret, Date.now()) }, cookie });
      expect(enabled.status).toBe(200);
      recoveryCodes = enabled.body.recoveryCodes;
      expect(recoveryCodes).toHaveLength(10);
      expect((await req("/api/auth/me", { cookie })).body).toMatchObject({ user: { totpEnabled: true }, recoveryCodesLeft: 10 });
      expect((await req("/api/auth/totp/setup", { method: "POST", cookie })).status).toBe(409);
    });

    it("asks for the code after a correct password, and accepts the next code once", async () => {
      const ip = freshIp();
      const step = await login(EMAIL, PASSWORD, { ip });
      expect(step.status).toBe(401);
      expect(step.body).toEqual({ error: "Enter the code from your authenticator app", totpRequired: true });
      expect(step.cookies).toEqual([]);
      // A wrong password never reveals that 2FA is on.
      expect((await login(EMAIL, "wrong-password-q", { ip })).body).toEqual({ error: "Incorrect email or password" });

      expect((await login(EMAIL, PASSWORD, { ip, totp: "123456" })).body).toEqual({ error: "That code is incorrect", totpRequired: true });
      // The enable step was used, so sign in with the next one (inside the ±1 window).
      const code = codeAt(secret, Date.now() + 30_000);
      const ok = await login(EMAIL, PASSWORD, { ip, totp: code });
      expect(ok.status).toBe(200);
      // Replaying the same code fails.
      expect((await login(EMAIL, PASSWORD, { ip, totp: code })).status).toBe(401);
      await ctx.server.auth.store.pool.query("update users set failed_attempts = 0, locked_until = null");
    });

    it("accepts each recovery code once", async () => {
      const ip = freshIp();
      const code = recoveryCodes[0]!;
      expect((await login(EMAIL, PASSWORD, { ip, totp: code.toUpperCase() })).status).toBe(200);
      expect((await login(EMAIL, PASSWORD, { ip, totp: code })).status).toBe(401);
      expect((await req("/api/auth/me", { cookie })).body.recoveryCodesLeft).toBe(9);
      await ctx.server.auth.store.pool.query("update users set failed_attempts = 0, locked_until = null");
    });

    it("disables only with the password", async () => {
      expect((await req("/api/auth/totp/disable", { json: { password: "wrong-password-d" }, cookie })).status).toBe(400);
      expect((await req("/api/auth/totp/disable", { json: { password: PASSWORD }, cookie })).status).toBe(200);
      expect((await login(EMAIL, PASSWORD, { ip: freshIp() })).status).toBe(200);
      expect((await req("/api/auth/me", { cookie })).body.user.totpEnabled).toBe(false);
    });
  });

  describe("WebSocket", () => {
    const open = (url: string, headers: Record<string, string>, hello: Record<string, unknown>) =>
      new Promise<{ welcome: boolean; code?: number; ws: WebSocket }>((resolve) => {
        // Node's WebSocket (undici) takes extra headers, standing in for the browser's cookie and Origin.
        const ws = new WebSocket(url, { headers } as any);
        ws.onopen = () => ws.send(JSON.stringify({ type: "hello", ...hello }));
        ws.onmessage = (e) => {
          if (JSON.parse(String(e.data)).type === "welcome") resolve({ welcome: true, ws });
        };
        ws.onclose = (e) => resolve({ welcome: false, code: e.code, ws });
      });

    it("accepts a client by its session cookie, refuses cross-site, and closes when the session is revoked", async () => {
      const net = await serveServer(ctx.server);
      try {
        const wsUrl = `${net.url.replace(/^http/, "ws")}/ws`;
        const host = new URL(net.url).host;
        const cookie = cookieOf(await login(EMAIL, PASSWORD, { ip: freshIp() }));

        const ok = await open(wsUrl, { cookie, origin: net.url }, { role: "client", token: "" });
        expect(ok.welcome).toBe(true);

        const noCookie = await open(wsUrl, { origin: net.url }, { role: "client", token: "" });
        expect(noCookie).toMatchObject({ welcome: false, code: 4003 });

        const crossSite = await open(wsUrl, { cookie, origin: "https://evil.example" }, { role: "client", token: "" });
        expect(crossSite).toMatchObject({ welcome: false, code: 4003 });

        // The token in hello still works without a cookie.
        const token = await open(wsUrl, {}, { role: "client", token: ADMIN });
        expect(token.welcome).toBe(true);
        token.ws.close();

        // A cookie never stands in for the worker token.
        const worker = await open(wsUrl, { cookie, origin: net.url }, { role: "worker", token: "", node: { id: "n1", name: "pc", capabilities: [] } });
        expect(worker).toMatchObject({ welcome: false, code: 4003 });

        const closed = new Promise<number>((resolve) => ok.ws.addEventListener("close", (e) => resolve(e.code)));
        await req("/api/auth/logout", { method: "POST", cookie, headers: { host } });
        expect(await closed).toBe(4003);
      } finally {
        await net.close();
      }
    });
  });

  describe("CLI", () => {
    const io = (passwords: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const cli: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), readPassword: async () => passwords.shift() ?? "" };
      return { cli, out, err };
    };
    const auth = () => new AuthService(ctx.server.auth.store.pool, { scrypt: FAST });

    it("creates a user, refusing duplicates and mismatched passwords", async () => {
      const pool = ctx.server.auth.store.pool;
      const a = io(["va-password-123", "va-password-123"]);
      expect(await runCli(["create", "--email", "VA@Example.com", "--name", "Assistant"], pool, a.cli, auth())).toBe(0);
      expect(a.out[0]).toMatch(/^Created admin va@example\.com/);
      expect((await login("va@example.com", "va-password-123", { ip: freshIp() })).status).toBe(200);

      const dup = io(["va-password-123", "va-password-123"]);
      expect(await runCli(["create", "--email", "va@example.com", "--name", "Again"], pool, dup.cli, auth())).toBe(1);
      expect(dup.err[0]).toMatch(/already exists/);

      const mismatch = io(["one-password-1", "two-password-2"]);
      expect(await runCli(["create", "--email", "x@example.com", "--name", "X"], pool, mismatch.cli, auth())).toBe(1);
      expect(mismatch.err[0]).toMatch(/don't match/);
    });

    it("resets a password: clears the lockout, signs out everywhere, and can turn 2FA off", async () => {
      const pool = ctx.server.auth.store.pool;
      const cookie = cookieOf(await login("va@example.com", "va-password-123", { ip: freshIp() }));
      await pool.query("update users set failed_attempts = 9, locked_until = now() + interval '1 hour', totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled_at = now() where email = 'va@example.com'");

      const r = io(["reset-password-1", "reset-password-1"]);
      expect(await runCli(["reset-password", "--email", "va@example.com", "--disable-2fa"], pool, r.cli, auth())).toBe(0);
      expect(r.out[0]).toMatch(/two-factor is off/);
      expect((await req("/api/tasks", { cookie })).status).toBe(401);
      expect((await login("va@example.com", "reset-password-1", { ip: freshIp() })).status).toBe(200);

      const missing = io(["reset-password-1", "reset-password-1"]);
      expect(await runCli(["reset-password", "--email", "nobody@example.com"], pool, missing.cli, auth())).toBe(1);
      expect(missing.err[0]).toMatch(/No user/);
    });

    it("lists users and explains usage", async () => {
      const pool = ctx.server.auth.store.pool;
      const l = io([]);
      // pnpm forwards a literal "--" before script arguments.
      expect(await runCli(["list", "--"], pool, l.cli, auth())).toBe(0);
      expect(l.out.join("\n")).toContain("dave@example.com\tDave\tadmin");
      const none = io([]);
      expect(await runCli([], pool, none.cli, auth())).toBe(1);
      expect(none.out[0]).toMatch(/^Usage/);
    });
  });

  it("migrations create the auth tables as expected", async () => {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      const { rows } = await client.query("select id from schema_migrations where id = '0006_auth'");
      expect(rows).toHaveLength(1);
      await expect(client.query("insert into users (id, email, name, password_hash) values (gen_random_uuid(), 'UPPER@x.com', 'u', 'h')")).rejects.toThrow(/check/);
    } finally {
      await client.end();
    }
  });
});
