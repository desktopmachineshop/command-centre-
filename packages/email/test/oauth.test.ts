import { afterEach, describe, expect, it } from "vitest";
import { EmailAccount, accessTokenFor, configureEmailOAuth, imapAuth, shouldSaveSent, smtpAuth } from "../src";

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
    expect(outlook().oauth?.tenant).toBe("common");
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
