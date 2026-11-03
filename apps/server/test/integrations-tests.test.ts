import type { ImapConnector } from "@cc/email";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import type { EntryInput } from "../src/integrations";
import { credentialTests } from "../src/integrations/tests";

type Call = { method: string; url: URL; headers: Headers; body: string };

/** A fake fetch: "METHOD host/path" → response. Unknown routes fail the test. */
function fake(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: init?.body ? String(init.body) : "" };
    calls.push(call);
    const route = routes[`${call.method} ${url.host}${url.pathname}`];
    if (!route) throw new Error(`unexpected ${call.method} ${url}`);
    return route(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const entry = (kind: string, data: Record<string, unknown>, secrets: Record<string, string>, id = "default"): EntryInput => ({ kind, id, data, secrets });
const config = {} as Config;
const noApps = { app: async () => undefined };
const apps = (values: Record<string, Record<string, string>>) => ({ app: async (kind: string) => values[kind] });

describe("connection tests", () => {
  it("claude: checks the token's format only", async () => {
    const t = credentialTests().claude!;
    expect(await t(entry("claude", {}, { oauthToken: "sk-ant-oat01-abc" }), config, noApps)).toMatchObject({ ok: true, message: expect.stringMatching(/first agent run/) });
    expect(await t(entry("claude", {}, { oauthToken: "sk-ant-api03-abc" }), config, noApps)).toMatchObject({ ok: false });
    expect(await t(entry("claude", { runner: "echo" }, {}), config, noApps)).toMatchObject({ ok: true });
  });

  it("anthropic: checks each key that is set", async () => {
    const { fetch, calls } = fake({
      "GET api.anthropic.com/v1/models": (c) => (c.headers.get("x-api-key") === "sk-ant-api03-good" ? json({ data: [] }) : json({ error: { type: "authentication_error" } }, 401)),
    });
    const t = credentialTests({ fetch }).anthropic!;
    const res = await t(entry("anthropic", {}, { fallbackApiKey: "sk-ant-api03-good", triageApiKey: "sk-ant-api03-bad" }), config, noApps);
    expect(res).toEqual({ ok: false, message: "Fallback key: works; Triage key: Anthropic rejected the credentials (HTTP 401)" });
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(res.message).not.toContain("sk-ant");
  });

  it("openai, elevenlabs and discord: one authenticated call", async () => {
    const { fetch, calls } = fake({
      "GET api.openai.com/v1/models": () => json({ data: [] }),
      "GET api.elevenlabs.io/v1/user": () => json({ first_name: "Dave", subscription: { tier: "starter" } }),
      "GET discord.com/api/v10/users/@me": () => json({ message: "401: Unauthorized" }, 401),
    });
    const tests = credentialTests({ fetch });
    expect(await tests.openai!(entry("openai", {}, { apiKey: "sk-openai" }), config, noApps)).toMatchObject({ ok: true });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-openai");
    expect(await tests.elevenlabs!(entry("elevenlabs", {}, { apiKey: "el-key" }), config, noApps)).toEqual({ ok: true, message: "ElevenLabs accepted the key (starter plan)", account: "Dave" });
    expect(await tests.discord!(entry("discord", {}, { botToken: "bot-token" }, "dms-discord"), config, noApps)).toEqual({ ok: false, message: "Discord rejected the credentials (HTTP 401)" });
    expect(calls[2]!.headers.get("authorization")).toBe("Bot bot-token");
  });

  it("odoo: signs in and reads the user's name", async () => {
    const { fetch } = fake({
      "POST dms.odoo.com/jsonrpc": (c) => {
        const { params } = JSON.parse(c.body) as { params: { service: string; method: string } };
        if (params.method === "authenticate") return json({ result: 7 });
        return json({ result: [{ id: 7, name: "Dave Smith" }] });
      },
    });
    const res = await credentialTests({ fetch }).odoo!(entry("odoo", { url: "https://dms.odoo.com", db: "dms", username: "dave@example.com" }, { apiKey: "odoo-key" }), config, noApps);
    expect(res).toEqual({ ok: true, message: "Signed in to Odoo as Dave Smith", account: "Dave Smith" });
  });

  it("email: IMAP login and SMTP verify", async () => {
    const opened: string[] = [];
    const imap: ImapConnector = async () => ({
      open: async (m) => {
        opened.push(m);
        return { uidValidity: "1", uidNext: 1 };
      },
      uidsAfter: async () => [],
      search: async () => [],
      fetchSource: async () => null,
      waitForMail: async () => {},
      appendToSent: async () => null,
      close: async () => {},
    });
    const data = { vertical: "dms", address: "shop@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com" };
    const good = await credentialTests({ imap, smtpVerify: async () => {} }).email!(entry("email", data, { password: "mail-pass-123" }, "dms-shop"), config, noApps);
    expect(good).toMatchObject({ ok: true, account: "shop@example.com" });
    expect(opened).toEqual(["INBOX"]);
    const bad = await credentialTests({ imap, smtpVerify: async () => Promise.reject(new Error("Invalid login for mail-pass-123")) }).email!(
      entry("email", data, { password: "mail-pass-123" }, "dms-shop"),
      config,
      noApps,
    );
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/SMTP \(smtp.example.com\): Invalid login/);
    expect(bad.message).not.toContain("mail-pass-123");
  });

  it("google: refresh token → access token → email", async () => {
    const { fetch, calls } = fake({
      "POST oauth2.googleapis.com/token": () => json({ access_token: "g-access", expires_in: 3600 }),
      "GET openidconnect.googleapis.com/v1/userinfo": () => json({ email: "dave@gmail.com" }),
    });
    const t = credentialTests({ fetch }).google!;
    const app = apps({ "google-app": { clientId: "c.apps.googleusercontent.com", clientSecret: "cs" } });
    expect(await t(entry("google", {}, { refreshToken: "1//rt" }, "g"), config, app)).toEqual({ ok: true, message: "Google accepted the sign-in (dave@gmail.com)", account: "dave@gmail.com" });
    expect(new URLSearchParams(calls[0]!.body).get("grant_type")).toBe("refresh_token");
    expect((await t(entry("google", {}, { refreshToken: "1//rt" }, "g"), config, noApps)).message).toMatch(/Google OAuth client/);
  });

  it("instagram and threads: GET /me, and say when the token has expired", async () => {
    const { fetch } = fake({
      "GET graph.instagram.com/v26.0/me": () => json({ error: { message: "Error validating access token", code: 190 } }, 400),
      "GET graph.threads.com/v1.0/me": () => json({ id: "42", username: "dmsltd" }),
    });
    const tests = credentialTests({ fetch });
    expect(await tests.instagram!(entry("instagram", {}, { accessToken: "IGAA-tok" }, "ig"), config, noApps)).toEqual({ ok: false, message: "Instagram says the sign-in has expired or was revoked; reconnect it" });
    expect(await tests.threads!(entry("threads", {}, { accessToken: "TH-tok" }, "th"), config, noApps)).toMatchObject({ ok: true, account: "@dmsltd" });
  });

  it("reddit: refresh-token grant, then /api/v1/me", async () => {
    const { fetch, calls } = fake({
      "POST www.reddit.com/api/v1/access_token": () => json({ access_token: "r-access" }),
      "GET oauth.reddit.com/api/v1/me": () => json({ name: "3dpandme" }),
    });
    const res = await credentialTests({ fetch }).reddit!(entry("reddit", {}, { refreshToken: "r-refresh" }, "r"), config, apps({ "reddit-app": { clientId: "cid", clientSecret: "sec" } }));
    expect(res).toEqual({ ok: true, message: "Reddit accepted the sign-in (u/3dpandme)", account: "u/3dpandme" });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: "r-refresh" });
  });

  it("developer apps: format checks", async () => {
    const tests = credentialTests();
    expect((await tests["google-app"]!(entry("google-app", { clientId: "123-x.apps.googleusercontent.com" }, { clientSecret: "s" }), config, noApps)).ok).toBe(true);
    expect((await tests["google-app"]!(entry("google-app", { clientId: "nope" }, { clientSecret: "s" }), config, noApps)).ok).toBe(false);
    expect((await tests["instagram-app"]!(entry("instagram-app", { appId: "1234567890" }, { appSecret: "0123456789abcdef0123456789abcdef" }), config, noApps)).ok).toBe(true);
    expect((await tests["threads-app"]!(entry("threads-app", { appId: "abc" }, { appSecret: "x" }), config, noApps)).ok).toBe(false);
    expect((await tests["reddit-app"]!(entry("reddit-app", { clientId: "c", userAgent: "python" }, { clientSecret: "s" }), config, noApps)).ok).toBe(false);
  });
});
