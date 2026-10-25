import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshExpiringTokens } from "../src/integrations/refresh";
import { ADMIN, DB_URL, makeServer, RecordingNotifier, resetDatabase } from "./helpers";

const BASE = "https://cc.example.com";
const FAST = { ln: 10, r: 8, p: 1 };
const EMAIL = "dave@example.com";

// Values that must never show up in a response, a redirect or the database in plain text.
const G_SECRET = "google-client-SECRET-0001";
const G_REFRESH = "1//google-refresh-TOKEN-0002";
const YT_REFRESH = "1//youtube-refresh-TOKEN-0003";
const IG_SECRET = "0123456789abcdef0123456789abcdef";
const IG_LONG = "IGAA-long-lived-TOKEN-0004";
const TH_SECRET = "fedcba9876543210fedcba9876543210";
const TH_LONG = "THAA-long-lived-TOKEN-0005";
const X_SECRET = "x-consumer-SECRET-0006-abcdefghij";
const X_ACCESS_SECRET = "x-access-token-SECRET-0007";
const R_SECRET = "reddit-SECRET-0008";
const R_REFRESH = "reddit-refresh-TOKEN-0009";
const ALL_SECRETS = [G_SECRET, G_REFRESH, YT_REFRESH, IG_SECRET, IG_LONG, TH_SECRET, TH_LONG, X_SECRET, X_ACCESS_SECRET, R_SECRET, R_REFRESH];

type Call = { method: string; url: URL; headers: Headers; form: URLSearchParams };

/** A fake for every provider host the sign-ins call. `fail` makes one route answer an error. */
function fakeProviders() {
  const calls: Call[] = [];
  const fail = new Set<string>();
  const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const form = (body: Record<string, string>) => new Response(new URLSearchParams(body).toString(), { headers: { "content-type": "application/x-www-form-urlencoded" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
    calls.push({ method, url, headers, form: body });
    const route = `${method} ${url.host}${url.pathname}`;
    if (fail.has(route)) return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400);
    switch (route) {
      case "POST oauth2.googleapis.com/token":
        if (body.get("grant_type") === "refresh_token") return json({ access_token: "g-access-refreshed", expires_in: 3600 });
        if (body.get("code") === "yt-code")
          return json({ access_token: "yt-access", refresh_token: YT_REFRESH, scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl" });
        return json({ access_token: "g-access", refresh_token: G_REFRESH, scope: "openid email https://www.googleapis.com/auth/calendar.events" });
      case "GET openidconnect.googleapis.com/v1/userinfo":
        return json({ email: "dave.personal@gmail.com", email_verified: true });
      case "GET www.googleapis.com/youtube/v3/channels":
        return json({ items: [{ id: "UC123abc", snippet: { title: "3D P and Me", customUrl: "@3dpandme" } }] });
      case "GET www.googleapis.com/calendar/v3/users/me/calendarList":
        return json({ items: [{ id: "primary-id@gmail.com", summary: "Dave", primary: true, accessRole: "owner" }, { id: "family@group.calendar.google.com", summary: "Family", accessRole: "reader" }] });
      case "POST api.instagram.com/oauth/access_token":
        // A real-sized Instagram id, beyond 2^53, as a bare JSON number.
        return json('{"access_token":"ig-short","user_id":17841400000000001,"permissions":"instagram_business_basic"}');
      case "GET graph.instagram.com/access_token":
        return json({ access_token: IG_LONG, token_type: "bearer", expires_in: 5184000 });
      case "GET graph.instagram.com/v26.0/me":
        return json('{"user_id":17841400000000001,"username":"dmsltd","id":"999"}');
      case "GET graph.instagram.com/refresh_access_token":
        return json({ access_token: `${IG_LONG}-renewed`, token_type: "bearer", expires_in: 5184000 });
      case "POST graph.threads.net/oauth/access_token":
        return json({ access_token: "th-short", user_id: 4242 });
      case "GET graph.threads.net/access_token":
        return json({ access_token: TH_LONG, expires_in: 5184000 });
      case "GET graph.threads.com/v1.0/me":
        return json({ id: "4242", username: "dmsltd" });
      case "POST api.x.com/oauth/request_token":
        return form({ oauth_token: "x-request-token", oauth_token_secret: "x-request-secret", oauth_callback_confirmed: "true" });
      case "POST api.x.com/oauth/access_token":
        return form({ oauth_token: "1-x-access-token", oauth_token_secret: X_ACCESS_SECRET, user_id: "1", screen_name: "dms_ltd" });
      case "GET api.x.com/2/users/me":
        return json({ data: { id: "1", username: "dms_ltd" } });
      case "POST www.reddit.com/api/v1/access_token":
        return json({ access_token: "r-access", refresh_token: R_REFRESH, token_type: "bearer", expires_in: 3600, scope: "identity submit" });
      case "GET oauth.reddit.com/api/v1/me":
        return json({ name: "3dpandme" });
      default:
        throw new Error(`unexpected ${route}`);
    }
  }) as typeof globalThis.fetch;
  return { fetch, calls, fail };
}

describe.skipIf(!DB_URL)("Accounts page sign-ins (OAuth)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let cookie = "";
  const providers = fakeProviders();

  /** A dashboard request as the signed-in user (cookie + CSRF header), or with the admin token. */
  const call = async (path: string, init: { method?: string; json?: unknown; as?: "user" | "admin" | "none" } = {}) => {
    const headers = new Headers({ "x-cc-request": "1" });
    if (init.json !== undefined) headers.set("content-type", "application/json");
    if ((init.as ?? "user") === "user") headers.set("cookie", cookie);
    if (init.as === "admin") headers.set("authorization", `Bearer ${ADMIN}`);
    const res = await ctx.server.app.request(path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const start = (provider: string, body: Record<string, unknown>, as: "user" | "admin" = "user") => call(`/api/integrations/oauth/${provider}/start`, { json: body, as });
  /** Follows the provider's redirect back; returns the Accounts page query it lands on. */
  const callback = async (provider: string, query: Record<string, string>, withCookie = true) => {
    const res = await ctx.server.app.request(`/oauth/${provider}/callback?${new URLSearchParams(query)}`, { headers: withCookie ? { cookie } : {} });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.startsWith("/#/accounts?")).toBe(true);
    for (const s of ALL_SECRETS) expect(location).not.toContain(s);
    return new URLSearchParams(location.slice("/#/accounts?".length));
  };
  const entry = async (kind: string, id: string) => (await call("/api/integrations")).body.entries.find((e: { kind: string; id: string }) => e.kind === kind && e.id === id);
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { PUBLIC_BASE_URL: `${BASE}/` }, overrides: { scrypt: FAST, integrationsFetch: providers.fetch } });
    const setup = await ctx.server.app.request("/api/auth/setup", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, name: "Dave", password: "a-long-test-password-1" }),
    });
    expect(setup.status).toBe(201);
    cookie = setup.headers.getSetCookie().find((c) => c.startsWith("cc_session="))!.split(";")[0]!;
  });
  afterAll(() => ctx.server.stop());

  it("refuses to start without the developer app, naming the keys to add", async () => {
    const res = await start("google", { id: "dave-google" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Add the Google OAuth client keys first (Developer apps → Google OAuth client: Client ID, Client secret)");
    const x = await start("x", { id: "dms-x", vertical: "dms" });
    expect(x.body.error).toMatch(/X app keys first.*API key, API key secret/);
  });

  it("needs a signed-in user or the admin token, and a known provider", async () => {
    expect((await call("/api/integrations/oauth/google/start", { json: { id: "a" }, as: "none" })).status).toBe(401);
    expect((await call("/api/integrations/google/a/calendars", { as: "none" })).status).toBe(401);
    expect((await start("myspace", { id: "a" })).status).toBe(404);
  });

  it("saves the developer apps", async () => {
    const apps: [string, Record<string, unknown>, Record<string, string>][] = [
      ["google-app", { clientId: "123-abc.apps.googleusercontent.com" }, { clientSecret: G_SECRET }],
      ["instagram-app", { appId: "1234567890" }, { appSecret: IG_SECRET }],
      ["threads-app", { appId: "2234567890" }, { appSecret: TH_SECRET }],
      ["x-app", { apiKey: "x-consumer-key-123" }, { apiSecret: X_SECRET }],
      ["reddit-app", { clientId: "reddit-cid" }, { clientSecret: R_SECRET }],
    ];
    for (const [kind, data, secrets] of apps) expect((await call(`/api/integrations/${kind}`, { method: "PUT", json: { data, secrets } })).status).toBe(200);
  });

  it("Google: PKCE sign-in saves the account with its email and a refresh token", async () => {
    const res = await start("google", { id: "dave-google" });
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/google/callback`);
    expect(url.searchParams.get("client_id")).toBe("123-abc.apps.googleusercontent.com");
    expect(url.searchParams.get("scope")).toContain("openid email https://www.googleapis.com/auth/calendar.events");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = stateOf(res.body.url);
    expect(Buffer.from(state, "base64url")).toHaveLength(32);

    const landed = await callback("google", { code: "g-code", state, scope: "openid email" });
    expect(Object.fromEntries(landed)).toEqual({ connected: "google", id: "dave-google" });

    const exchange = providers.calls.find((c) => c.url.host === "oauth2.googleapis.com" && c.form.get("code") === "g-code")!;
    expect(createHash("sha256").update(exchange.form.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(exchange.form.get("redirect_uri")).toBe(`${BASE}/oauth/google/callback`);

    const e = await entry("google", "dave-google");
    expect(e).toMatchObject({ source: "app", data: { email: "dave.personal@gmail.com", vertical: "personal", useForCalendar: true }, meta: { account: "dave.personal@gmail.com" } });
    expect(JSON.parse(e.data.calendars)).toEqual([{ id: "primary" }]);
    expect(e.secrets.refreshToken).toBe(`••••${G_REFRESH.slice(-4)}`);
    const cal = ctx.server.integrations.current().pa.calendarAccounts.find((a) => a.id === "dave-google");
    expect(cal?.credentials).toEqual({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: G_SECRET, refreshToken: G_REFRESH });
    const audit = await ctx.server.store.pool.query("select actor from integration_audit where kind = 'google'");
    expect(audit.rows).toEqual([{ actor: EMAIL }]);
  });

  it("Google: lists the account's calendars for the picker", async () => {
    const res = await call("/api/integrations/google/dave-google/calendars");
    expect(res.status).toBe(200);
    expect(res.body.calendars).toEqual([
      { id: "primary-id@gmail.com", summary: "Dave", primary: true, accessRole: "owner" },
      { id: "family@group.calendar.google.com", summary: "Family", primary: false, accessRole: "reader" },
    ]);
    expect((await call("/api/integrations/google/nobody/calendars")).status).toBe(404);
  });

  it("YouTube: saves the channel id, handle and refresh token", async () => {
    const res = await start("youtube", { id: "3dp-youtube", vertical: "3dpandme", data: { inbound: false } });
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/youtube/callback`);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(Object.fromEntries(await callback("youtube", { code: "yt-code", state: stateOf(res.body.url) }))).toEqual({ connected: "youtube", id: "3dp-youtube" });
    const e = await entry("youtube", "3dp-youtube");
    expect(e.data).toMatchObject({ vertical: "3dpandme", channelId: "UC123abc", handle: "@3dpandme", displayName: "3D P and Me", inbound: false });
    const account = ctx.server.integrations.current().social.accounts.find((a) => a.id === "3dp-youtube");
    expect(account?.credentials).toMatchObject({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: G_SECRET, refreshToken: YT_REFRESH, channelId: "UC123abc" });
  });

  it("Instagram: swaps for a long-lived token, stores the expiry and the exact user id", async () => {
    const res = await start("instagram", { id: "dms-instagram", vertical: "dms" });
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("1234567890");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/instagram/callback`);
    expect(Object.fromEntries(await callback("instagram", { code: "ig-code#_", state: stateOf(res.body.url) }))).toEqual({ connected: "instagram", id: "dms-instagram" });

    const exchange = providers.calls.find((c) => c.url.host === "api.instagram.com")!;
    expect(exchange.form.get("code")).toBe("ig-code");
    expect(providers.calls.find((c) => c.url.pathname === "/access_token" && c.url.host === "graph.instagram.com")!.url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    const e = await entry("instagram", "dms-instagram");
    expect(e.data).toMatchObject({ igUserId: "17841400000000001", handle: "@dmsltd", vertical: "dms" });
    expect(e.meta.account).toBe("@dmsltd");
    expect(Date.parse(e.meta.expiresAt) - Date.now()).toBeGreaterThan(59 * 86_400_000);
    const account = ctx.server.integrations.current().social.accounts.find((a) => a.id === "dms-instagram");
    expect(account?.credentials).toEqual({ accessToken: IG_LONG, igUserId: "17841400000000001" });
  });

  it("Threads: long-lived token and user id", async () => {
    const res = await start("threads", { id: "dms-threads", vertical: "dms" });
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe("https://threads.net/oauth/authorize");
    expect(url.searchParams.get("scope")).toContain("threads_content_publish");
    expect(Object.fromEntries(await callback("threads", { code: "th-code", state: stateOf(res.body.url) }))).toEqual({ connected: "threads", id: "dms-threads" });
    expect(providers.calls.find((c) => c.url.host === "graph.threads.net" && c.url.pathname === "/access_token")!.url.searchParams.get("grant_type")).toBe("th_exchange_token");
    const e = await entry("threads", "dms-threads");
    expect(e.data).toMatchObject({ threadsUserId: "4242", handle: "@dmsltd" });
    expect(e.meta.expiresAt).toBeTruthy();
  });

  it("X: OAuth 1.0a request token → authorize → access token", async () => {
    const res = await start("x", { id: "dms-x", vertical: "dms" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://api.x.com/oauth/authorize?oauth_token=x-request-token");
    const reqToken = providers.calls.find((c) => c.url.pathname === "/oauth/request_token")!;
    const auth = reqToken.headers.get("authorization")!;
    expect(auth).toContain(`oauth_callback="${encodeURIComponent(`${BASE}/oauth/x/callback`)}"`);
    expect(auth).toContain('oauth_consumer_key="x-consumer-key-123"');
    expect(auth).not.toContain("oauth_token=");

    expect(Object.fromEntries(await callback("x", { oauth_token: "x-request-token", oauth_verifier: "verif-1" }))).toEqual({ connected: "x", id: "dms-x" });
    const access = providers.calls.find((c) => c.url.pathname === "/oauth/access_token" && c.url.host === "api.x.com")!.headers.get("authorization")!;
    expect(access).toContain('oauth_token="x-request-token"');
    expect(access).toContain('oauth_verifier="verif-1"');
    const e = await entry("x", "dms-x");
    expect(e.data.handle).toBe("@dms_ltd");
    const account = ctx.server.integrations.current().social.accounts.find((a) => a.id === "dms-x");
    expect(account?.credentials).toEqual({ apiKey: "x-consumer-key-123", apiSecret: X_SECRET, accessToken: "1-x-access-token", accessTokenSecret: X_ACCESS_SECRET });
  });

  it("Reddit: permanent code flow saves a refresh token and the username", async () => {
    const res = await start("reddit", { id: "3dp-reddit", vertical: "3dpandme" });
    const url = new URL(res.body.url);
    expect(url.searchParams.get("duration")).toBe("permanent");
    expect(url.searchParams.get("scope")).toBe("identity submit read privatemessages edit history");
    expect(Object.fromEntries(await callback("reddit", { code: "r-code", state: stateOf(res.body.url) }))).toEqual({ connected: "reddit", id: "3dp-reddit" });
    const exchange = providers.calls.find((c) => c.url.host === "www.reddit.com")!;
    expect(exchange.headers.get("authorization")).toBe(`Basic ${Buffer.from(`reddit-cid:${R_SECRET}`).toString("base64")}`);
    expect(exchange.form.get("grant_type")).toBe("authorization_code");
    expect((await entry("reddit", "3dp-reddit")).data.handle).toBe("u/3dpandme");
    const account = ctx.server.integrations.current().social.accounts.find((a) => a.id === "3dp-reddit");
    expect(account?.credentials).toEqual({ clientId: "reddit-cid", clientSecret: R_SECRET, refreshToken: R_REFRESH });
  });

  it("never returns or stores a token in plain text", async () => {
    const list = JSON.stringify((await call("/api/integrations")).body);
    for (const s of ALL_SECRETS) expect(list).not.toContain(s);
    const { rows } = await ctx.server.store.pool.query("select * from integration_entries");
    for (const s of ALL_SECRETS) expect(JSON.stringify(rows)).not.toContain(s);
  });

  it("rejects an unknown, reused or expired state without saving anything", async () => {
    const before = await ctx.server.store.pool.query("select count(*)::int as n from integration_audit");
    expect((await callback("reddit", { code: "r-code", state: "made-up" })).get("oauthError")).toMatch(/expired or was already used/);
    expect((await callback("reddit", { code: "r-code" })).get("oauthError")).toMatch(/without its state/);

    const res = await start("reddit", { id: "reused", vertical: "dms" });
    const state = stateOf(res.body.url);
    expect((await callback("reddit", { code: "r-code", state })).get("connected")).toBe("reddit");
    expect((await callback("reddit", { code: "r-code", state })).get("oauthError")).toMatch(/already used/);

    const res2 = await start("reddit", { id: "expired-one", vertical: "dms" });
    await ctx.server.store.pool.query("update oauth_states set expires_at = now() - interval '1 second'");
    expect((await callback("reddit", { code: "r-code", state: stateOf(res2.body.url) })).get("oauthError")).toMatch(/expired/);

    // A state is bound to its provider.
    const res3 = await start("reddit", { id: "wrong-provider", vertical: "dms" });
    expect((await callback("google", { code: "r-code", state: stateOf(res3.body.url) })).get("oauthError")).toMatch(/expired or was already used/);

    const after = await ctx.server.store.pool.query("select count(*)::int as n from integration_audit");
    expect(after.rows[0].n).toBe(before.rows[0].n + 1); // only the one good callback
    expect(await entry("reddit", "expired-one")).toBeUndefined();
  });

  it("handles the provider's refusal", async () => {
    const res = await start("instagram", { id: "refused-ig", vertical: "dms" });
    const state = stateOf(res.body.url);
    const landed = await callback("instagram", { error: "access_denied", error_reason: "user_denied", state });
    expect(landed.get("oauthError")).toBe("Access was not granted");
    expect(await entry("instagram", "refused-ig")).toBeUndefined();
    // The state is used up.
    expect((await callback("instagram", { code: "c", state })).get("oauthError")).toMatch(/already used/);

    const x = await start("x", { id: "refused-x", vertical: "dms" });
    expect(x.status).toBe(200);
    expect((await callback("x", { denied: "x-request-token" })).get("oauthError")).toBe("Access was not granted");
  });

  it("must be finished by the user who started it; admin-token flows finish anywhere", async () => {
    const res = await start("reddit", { id: "someone-else", vertical: "dms" });
    expect((await callback("reddit", { code: "r-code", state: stateOf(res.body.url) }, false)).get("oauthError")).toMatch(/user who pressed Connect/);
    expect(await entry("reddit", "someone-else")).toBeUndefined();

    const byToken = await start("reddit", { id: "by-token", vertical: "dms" }, "admin");
    expect((await callback("reddit", { code: "r-code", state: stateOf(byToken.body.url) }, false)).get("connected")).toBe("reddit");
  });

  it("reports a provider failure in the redirect, without the secrets", async () => {
    providers.fail.add("POST api.instagram.com/oauth/access_token");
    const res = await start("instagram", { id: "broken-ig", vertical: "dms" });
    const landed = await callback("instagram", { code: "ig-code", state: stateOf(res.body.url) });
    expect(landed.get("oauthError")).toMatch(/Instagram's code exchange failed: Invalid OAuth access token/);
    providers.fail.clear();
    expect(await entry("instagram", "broken-ig")).toBeUndefined();
  });

  it("validates the start request", async () => {
    expect((await start("instagram", { id: "Bad id!", vertical: "dms" })).status).toBe(400);
    const noBusiness = await start("instagram", { id: "no-business" });
    expect(noBusiness.status).toBe(400);
    expect(noBusiness.body.error).toMatch(/Pick which business/);
    expect((await start("instagram", { id: "x1", vertical: "nope" })).body.error).toMatch(/doesn't exist/);
    expect((await start("instagram", { id: "x1", vertical: "dms", data: { accessToken: "sneaky" } })).status).toBe(400);
    expect((await start("instagram", { id: "x1", vertical: "dms", data: { igUserId: "1" } })).status).toBe(400);
    expect((await start("instagram", { id: "x1", vertical: "dms", data: { inbound: "yes" } })).body.error).toMatch(/must be on or off/);
  });

  it("refresh job: renews a token expiring in 10 days, alerts when renewal fails", async () => {
    const service = ctx.server.integrations;
    const now = new Date();
    const soon = new Date(now.getTime() + 10 * 86_400_000).toISOString();
    await service.patchMeta("instagram", "dms-instagram", { expiresAt: soon });
    await service.patchMeta("threads", "dms-threads", { expiresAt: soon });
    providers.fail.add("GET graph.threads.com/refresh_access_token");
    const notifier = new RecordingNotifier();
    const result = await refreshExpiringTokens({ service, notifier, fetch: providers.fetch, now: () => now });
    providers.fail.clear();

    expect(result.refreshed).toEqual(["instagram/dms-instagram"]);
    expect(result.failed).toEqual(["threads/dms-threads"]);
    const ig = await service.entry("instagram", "dms-instagram");
    expect(ig!.secrets.accessToken).toBe(`${IG_LONG}-renewed`);
    expect(Date.parse(ig!.meta.expiresAt!) - now.getTime()).toBeGreaterThan(59 * 86_400_000);
    expect(service.current().social.accounts.find((a) => a.id === "dms-instagram")?.credentials.accessToken).toBe(`${IG_LONG}-renewed`);
    const renew = providers.calls.find((c) => c.url.pathname === "/refresh_access_token" && c.url.host === "graph.instagram.com")!;
    expect(renew.url.searchParams.get("grant_type")).toBe("ig_refresh_token");

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ title: "Threads sign-in expiring", url: "/accounts", category: "alert", tag: "integration-expiry-threads-dms-threads" });
    expect(notifier.sent[0]!.body).toMatch(/expires in 10 days and couldn't be renewed.*Reconnect it on the Accounts page/);
    for (const s of ALL_SECRETS) expect(JSON.stringify(notifier.sent)).not.toContain(s);
    const audit = await ctx.server.store.pool.query("select actor from integration_audit where kind = 'instagram' and entry_id = 'dms-instagram' order by id desc limit 1");
    expect(audit.rows[0].actor).toBe("system");

    // Far from expiry: nothing to do.
    const again = await refreshExpiringTokens({ service, notifier: new RecordingNotifier(), fetch: providers.fetch, now: () => now });
    expect(again.refreshed).toEqual([]);
  });

  it("tests a connection with the saved sign-in and the app keys", async () => {
    const res = await call("/api/integrations/x/dms-x/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: "X accepted the sign-in (@dms_ltd)", account: "@dms_ltd" });
    const me = providers.calls.find((c) => c.url.pathname === "/2/users/me")!;
    expect(me.headers.get("authorization")).toContain('oauth_token="1-x-access-token"');
    expect((await entry("x", "dms-x")).meta.lastTest).toMatchObject({ ok: true });
    expect((await call("/api/integrations")).body.kinds.find((k: { kind: string }) => k.kind === "x").testable).toBe(true);
  });
});

describe.skipIf(!DB_URL)("Accounts page sign-ins without PUBLIC_BASE_URL", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { integrationsFetch: fakeProviders().fetch } });
  });
  afterAll(() => ctx.server.stop());

  it("refuses to start", async () => {
    await ctx.api("/api/integrations/google-app", { method: "PUT", json: { data: { clientId: "1-a.apps.googleusercontent.com" }, secrets: { clientSecret: "s" } } });
    const res = await ctx.api("/api/integrations/oauth/google/start", { method: "POST", json: { id: "g" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PUBLIC_BASE_URL/);
  });
});
