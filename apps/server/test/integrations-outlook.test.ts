import { configureEmailOAuth, MemoryMailbox, smtpAuth } from "@cc/email";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, DB_URL, makeServer, resetDatabase } from "./helpers";

const BASE = "https://cc.example";
const REFRESH = "M.R3_BAY.refresh-token-from-microsoft-0001";
const ROTATED = "M.R3_BAY.refresh-token-rotated-0002";
const SECRET = "microsoft-client-secret-value-0003";
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

/** login.microsoftonline.com, faked: the code exchange, then refresh-token swaps. */
function fakeMicrosoft() {
  const forms: URLSearchParams[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/oauth2/v2.0/token")) return new Response("not found", { status: 404 });
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    if (form.get("grant_type") === "authorization_code") {
      if (form.get("code") !== "ms-code" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "at-0",
        refresh_token: REFRESH,
        scope: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email",
        id_token: idToken({ preferred_username: "Shop@Outlook.com" }),
      });
    }
    return Response.json({ access_token: "at-1", refresh_token: ROTATED, expires_in: 3600 });
  }) as typeof globalThis.fetch;
  return { fetch, forms };
}

describe.skipIf(!DB_URL)("Outlook / Hotmail sign-in", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const ms = fakeMicrosoft();
  const mailbox = new MemoryMailbox();
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

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { PUBLIC_BASE_URL: BASE }, overrides: { integrationsFetch: ms.fetch, imap: mailbox.connector, smtpVerify: async (a) => void smtpLogins.push(await smtpAuth(a)) } });
    // Token refreshes go to the fake too (the server keeps its own rotation callback).
    configureEmailOAuth({ fetch: ms.fetch, loginBase: "https://login.test" });
  });
  afterAll(() => ctx.server.stop());

  it("needs the Microsoft app first", async () => {
    const res = await call("/api/integrations/oauth/microsoft/start", { json: { id: "dms-outlook", vertical: "dms" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Microsoft app/);
  });

  it("connects a mailbox: PKCE sign-in, address from the id token, IMAP/SMTP over OAuth", async () => {
    expect((await call("/api/integrations/microsoft-app", { method: "PUT", json: { data: { clientId: "ms-client-id" }, secrets: { clientSecret: SECRET } } })).status).toBe(200);
    const start = await call("/api/integrations/oauth/microsoft/start", { json: { id: "dms-outlook", vertical: "dms" } });
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/microsoft/callback`);
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const back = await ctx.server.app.request(`/oauth/microsoft/callback?code=ms-code&state=${url.searchParams.get("state")}`);
    expect(back.headers.get("location")).toBe("/#/accounts?connected=outlook&id=dms-outlook");
    expect(ms.forms[0]!.get("client_secret")).toBe(SECRET);

    const account = ctx.server.integrations.current().email.accounts.find((a) => a.id === "dms-outlook")!;
    expect(account).toMatchObject({
      address: "shop@outlook.com",
      imap: { host: "outlook.office365.com", port: 993, secure: true, user: "shop@outlook.com" },
      smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
      oauth: { provider: "microsoft", clientId: "ms-client-id", tenant: "common", refreshToken: REFRESH },
    });
    const list = await call("/api/integrations");
    expect(JSON.stringify(list.body)).not.toContain(REFRESH);
    expect(list.body.entries.find((e: { kind: string }) => e.kind === "outlook")).toMatchObject({ source: "app", meta: { account: "shop@outlook.com" } });
  });

  it("Test signs in to the mailbox, and Microsoft's renewed refresh token is saved", async () => {
    const res = await call("/api/integrations/outlook/dms-outlook/test", { method: "POST" });
    expect(res.body).toMatchObject({ ok: true });
    // SMTP signed in with an XOAUTH2 access token from the refresh-token swap, not a password.
    expect(smtpLogins).toEqual([{ type: "OAuth2", user: "shop@outlook.com", accessToken: "at-1" }]);
    // The swap returned a new refresh token: stored (encrypted), no reload needed.
    await new Promise((r) => setTimeout(r, 50));
    const saved = await ctx.server.integrations.entry("outlook", "dms-outlook");
    expect(saved?.secrets.refreshToken).toBe(ROTATED);
    expect(ctx.server.integrations.current().email.accounts.find((a) => a.id === "dms-outlook")?.oauth?.refreshToken).toBe(ROTATED);
  });

  it("an Outlook name can't clash with another mailbox", async () => {
    const clash = await call("/api/integrations/email/dms-outlook", {
      method: "PUT",
      json: { data: { vertical: "dms", address: "a@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com" }, secrets: { password: "pw" } },
    });
    expect(clash.status).toBe(409);
  });
});
