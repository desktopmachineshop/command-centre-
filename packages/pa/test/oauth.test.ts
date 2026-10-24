import { describe, expect, it } from "vitest";
import { createGoogleTokenProvider, GoogleAuthError, googleCredentialsFromEnv, GoogleTokenError } from "../src/google/oauth";
import { DEFAULT_AUTH_SCOPES, parseScopes } from "../src";
import { FakeGoogle } from "./fake-google";

const creds = { clientId: "cid", clientSecret: "sec-123", refreshToken: "1//tok-456" };

describe("createGoogleTokenProvider (shared with Drive storage)", () => {
  it("caches until a minute before expiry", async () => {
    const google = new FakeGoogle();
    google.tokenResponses = [{ json: { access_token: "a1", expires_in: 120 } }, { json: { access_token: "a2", expires_in: 120 } }];
    let now = 0;
    const tokens = createGoogleTokenProvider({ ...creds, fetch: google.fetch, now: () => now });
    expect(await tokens.getAccessToken()).toBe("a1");
    now = 30_000;
    expect(await tokens.getAccessToken()).toBe("a1");
    now = 61_000;
    expect(await tokens.getAccessToken()).toBe("a2");
    tokens.invalidate();
    await tokens.getAccessToken();
    expect(google.tokenCount).toBe(3);
  });

  it("says to re-run google:auth on invalid_grant, and keeps other failures distinct", async () => {
    const google = new FakeGoogle();
    google.tokenResponses = [{ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }];
    const err = await createGoogleTokenProvider({ ...creds, fetch: google.fetch, label: "Drive storage" }).getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.code).toBe("invalid_grant");
    expect(err.message).toMatch(/for Drive storage.*expired or been revoked.*google:auth/s);
    expect(err.message).not.toContain(creds.refreshToken);

    const down = new FakeGoogle();
    down.tokenResponses = [{ status: 503, json: {} }];
    await expect(createGoogleTokenProvider({ ...creds, fetch: down.fetch }).getAccessToken()).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it("reads the shared GOOGLE_* variables", () => {
    expect(googleCredentialsFromEnv({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GOOGLE_REFRESH_TOKEN: "c" })).toEqual({ clientId: "a", clientSecret: "b", refreshToken: "c" });
    expect(googleCredentialsFromEnv({ GOOGLE_CLIENT_ID: "a" })).toBeNull();
  });

  it("asks for calendar and drive.file by default; --scopes overrides", () => {
    expect(DEFAULT_AUTH_SCOPES).toContain("https://www.googleapis.com/auth/drive.file");
    expect(DEFAULT_AUTH_SCOPES).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(parseScopes("calendar.events, drive.file")).toEqual(["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/drive.file"]);
    expect(parseScopes(undefined)).toBe(DEFAULT_AUTH_SCOPES);
  });
});
