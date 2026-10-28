import { configureEmailOAuth, MemoryMailbox, smtpAuth } from "@cc/email";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

const BASE = "https://cc.example";
const REFRESH = "1//gmail-full-refresh-token-0001";
const SECRET = "google-client-secret-0002";

/** What the fake Google says was granted. */
let granted = "openid https://www.googleapis.com/auth/userinfo.email https://mail.google.com/";

/** Google, faked: the code exchange (with whatever scope was granted) and userinfo. */
function fakeGoogle() {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code") return Response.json({ access_token: "g-at", refresh_token: REFRESH, scope: granted });
      return Response.json({ access_token: "g-at-2", expires_in: 3600 });
    }
    if (url.includes("userinfo")) return Response.json({ email: "Shop@Gmail.com" });
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return fetch;
}

describe.skipIf(!DB_URL)("Gmail inbox: Connect only", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const smtpLogins: unknown[] = [];
  const call = async (path: string, init: { method?: string; json?: unknown } = {}) => {
    const res = await ctx.server.app.request(path, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const connect = async (id: string) => {
    const start = await call("/api/integrations/oauth/gmail/start", { json: { id, vertical: "dms" } });
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    const back = await ctx.server.app.request(`/oauth/gmail/callback?code=g-code&state=${url.searchParams.get("state")}`);
    return { url, location: back.headers.get("location")! };
  };

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({
      env: { PUBLIC_BASE_URL: BASE },
      overrides: { integrationsFetch: fakeGoogle(), imap: new MemoryMailbox().connector, smtpVerify: async (a) => void smtpLogins.push(await smtpAuth(a)) },
    });
    configureEmailOAuth({ fetch: fakeGoogle(), googleToken: "https://oauth2.googleapis.com/token" });
    await call("/api/integrations/google-app", { method: "PUT", json: { data: { clientId: "id.apps.googleusercontent.com" }, secrets: { clientSecret: SECRET } } });
  });
  afterAll(() => ctx.server.stop());

  it("asks Google for the full mailbox, then reads and sends with that sign-in, no app password", async () => {
    const { url, location } = await connect("dms-gmail");
    expect(url.searchParams.get("scope")).toBe("openid email https://mail.google.com/");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/gmail/callback`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(location).toBe("/#/accounts?connected=gmail&id=dms-gmail");

    const account = ctx.server.integrations.current().email.accounts.find((a) => a.id === "dms-gmail")!;
    expect(account).toMatchObject({
      address: "shop@gmail.com",
      imap: { host: "imap.gmail.com", user: "shop@gmail.com" },
      oauth: { provider: "google", clientId: "id.apps.googleusercontent.com", refreshToken: REFRESH },
    });
    expect(account.imap.pass).toBeUndefined();
    expect(JSON.stringify((await call("/api/integrations")).body)).not.toContain(REFRESH);

    const test = await call("/api/integrations/gmail/dms-gmail/test", { method: "POST" });
    expect(test.body).toMatchObject({ ok: true });
  });

  it("refuses a sign-in that didn't grant the mailbox", async () => {
    granted = "openid email";
    const { location } = await connect("dms-gmail-2");
    expect(decodeURIComponent(location)).toMatch(/oauthError=Google didn't grant access to the mailbox/);
  });
});
