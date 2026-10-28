import { afterEach, describe, expect, it } from "vitest";
import { EmailAccount, accessTokenFor, configureEmailOAuth, createEmailExecutors, imapAuth, sendRoute, shouldSaveSent, smtpAuth } from "../src";

const outlook = (refreshToken = "rt-1") =>
  EmailAccount.parse({
    id: "dms-outlook",
    vertical: "dms",
    address: "shop@outlook.com",
    imap: { host: "outlook.office365.com", port: 993, secure: true, user: "shop@outlook.com" },
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false, user: "shop@outlook.com" },
    oauth: { provider: "microsoft", clientId: "cid", clientSecret: "secret", refreshToken },
  });

function fakeMicrosoft(responses: { status?: number; body: Record<string, unknown> }[]) {
  const calls: URLSearchParams[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(new URLSearchParams(String(init.body)));
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Microsoft mailbox sign-in", () => {
  afterEach(() => configureEmailOAuth({ onRotate: undefined }));

  it("needs a password only without OAuth", () => {
    expect(outlook().oauth).toMatchObject({ provider: "microsoft", tenant: "common" });
    expect(() => EmailAccount.parse({ ...outlook(), id: "x", oauth: undefined })).toThrow(/imap.pass and smtp.pass/);
  });

  it("swaps the refresh token for an access token, caches it, and saves the rotated refresh token", async () => {
    const ms = fakeMicrosoft([{ body: { access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 } }]);
    const rotated: string[] = [];
    configureEmailOAuth({ fetch: ms.fetch, loginBase: "https://login.test", onRotate: (_id, t) => rotated.push(t) });
    const account = outlook("rt-cache");
    expect(await imapAuth(account)).toEqual({ user: "shop@outlook.com", accessToken: "at-1" });
    expect(await smtpAuth(account)).toEqual({ type: "OAuth2", user: "shop@outlook.com", accessToken: "at-1" });
    expect(ms.calls).toHaveLength(1);
    expect(ms.calls[0]!.get("grant_type")).toBe("refresh_token");
    expect(ms.calls[0]!.get("refresh_token")).toBe("rt-cache");
    expect(ms.calls[0]!.get("scope")).toContain("IMAP.AccessAsUser.All");
    expect(rotated).toEqual(["rt-2"]);
  });

  it("says to reconnect when the sign-in was revoked, without the token", async () => {
    const ms = fakeMicrosoft([{ status: 400, body: { error: "invalid_grant" } }]);
    configureEmailOAuth({ fetch: ms.fetch, loginBase: "https://login.test" });
    const err = await accessTokenFor(outlook("rt-revoked")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/reconnect it on the Accounts page/);
    expect((err as Error).message).not.toContain("rt-revoked");
  });

  it("leaves filing Sent to Microsoft", () => {
    expect(shouldSaveSent(outlook())).toBe(false);
  });
});

describe("sending over HTTPS (no SMTP port needed)", () => {
  /** Google's token endpoint, the Gmail API and Microsoft's login + Graph, faked. */
  function fakeApis() {
    const sent: { url: string; headers: Headers; body: string }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === "https://google.test/token") return Response.json({ access_token: "g-at", expires_in: 3600 });
      if (url.startsWith("https://login.test/")) return Response.json({ access_token: "graph-at", expires_in: 3600 });
      sent.push({ url, headers, body: String(init?.body) });
      if (url.startsWith("https://gmail.test/")) return Response.json({ id: "gmail-msg-1" });
      if (url.startsWith("https://graph.test/")) return new Response(null, { status: 202 });
      return new Response("nope", { status: 404 });
    }) as typeof globalThis.fetch;
    configureEmailOAuth({ fetch, loginBase: "https://login.test", googleToken: "https://google.test/token", gmailApi: "https://gmail.test", graphApi: "https://graph.test" });
    return sent;
  }
  const noImap = async () => {
    throw new Error("IMAP not expected");
  };

  it("a Gmail inbox with a Google sign-in sends through the Gmail API", async () => {
    const sent = fakeApis();
    const gmail = EmailAccount.parse({
      id: "dms-gmail",
      vertical: "dms",
      address: "shop@gmail.com",
      imap: { host: "imap.gmail.com", port: 993, secure: true, user: "shop@gmail.com", pass: "app-password" },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "shop@gmail.com", pass: "app-password" },
      send: { via: "gmail", clientId: "cid", clientSecret: "cs", refreshToken: "g-rt" },
    });
    expect(sendRoute(gmail)).toBe("gmail");
    expect(shouldSaveSent(gmail)).toBe(false);
    const ex = createEmailExecutors([gmail], { connect: noImap });
    await ex["email.send"]!.execute({ accountId: "dms-gmail", to: ["customer@example.com"], subject: "Your order", body: "It shipped today." } as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://gmail.test/gmail/v1/users/me/messages/send");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer g-at");
    const raw = Buffer.from(JSON.parse(sent[0]!.body).raw, "base64url").toString();
    expect(raw).toContain("To: customer@example.com");
    expect(raw).toContain("It shipped today.");
  });

  it("an Outlook inbox sends through Microsoft Graph", async () => {
    const sent = fakeApis();
    const account = outlook("rt-graph");
    expect(sendRoute(account)).toBe("graph");
    const ex = createEmailExecutors([account], { connect: noImap });
    await ex["email.send"]!.execute({ accountId: "dms-outlook", to: ["customer@example.com"], subject: "Hi", body: "Hello there." } as never);
    expect(sent[0]!.url).toBe("https://graph.test/v1.0/me/sendMail");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer graph-at");
    expect(sent[0]!.headers.get("content-type")).toBe("text/plain");
    expect(Buffer.from(sent[0]!.body, "base64").toString()).toContain("Hello there.");
  });
});

describe("Gmail with Connect only (no app password)", () => {
  it("reads over IMAP with XOAUTH2 and sends through the Gmail API, one Google token", async () => {
    const sent: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://google.test/token") {
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("g-full-rt");
        return Response.json({ access_token: "g-full-at", expires_in: 3600 });
      }
      sent.push(url);
      return Response.json({ id: "m1" });
    }) as typeof globalThis.fetch;
    configureEmailOAuth({ fetch, googleToken: "https://google.test/token", gmailApi: "https://gmail.test" });
    const gmail = EmailAccount.parse({
      id: "dms-gmail2",
      vertical: "dms",
      address: "shop@gmail.com",
      imap: { host: "imap.gmail.com", port: 993, secure: true, user: "shop@gmail.com" },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "shop@gmail.com" },
      oauth: { provider: "google", clientId: "cid", clientSecret: "cs", refreshToken: "g-full-rt" },
    });
    expect(await imapAuth(gmail)).toEqual({ user: "shop@gmail.com", accessToken: "g-full-at" });
    expect(sendRoute(gmail)).toBe("gmail");
    expect(shouldSaveSent(gmail)).toBe(false);
    const ex = createEmailExecutors([gmail], { connect: async () => { throw new Error("no IMAP"); } });
    await ex["email.send"]!.execute({ accountId: "dms-gmail2", to: ["a@example.com"], subject: "Hi", body: "Hello." } as never);
    expect(sent).toEqual(["https://gmail.test/gmail/v1/users/me/messages/send"]);
  });
});
