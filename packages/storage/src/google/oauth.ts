import { redact } from "../util";

/**
 * Minimal Google OAuth token provider: exchanges a long-lived refresh token for
 * short-lived access tokens and caches each one until a minute before it expires.
 *
 * Same signature as `createGoogleTokenProvider` in packages/pa/src/google/oauth.ts
 * (Calendar), so the two can be merged into one; `forceRefresh` is an optional
 * extra used after a 401.
 * Token endpoint: https://developers.google.com/identity/protocols/oauth2/web-server#offline
 */
export interface GoogleTokenProvider {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

export interface GoogleTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GoogleAuthError extends Error {}

export function createGoogleTokenProvider(options: GoogleTokenProviderOptions): GoogleTokenProvider {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const refresh = async (): Promise<string> => {
    const res = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        refresh_token: options.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      // invalid_grant: the refresh token was revoked, or expired (7 days while the OAuth app is in "Testing").
      throw new GoogleAuthError(`Google token refresh failed (${res.status}): ${redact(text).slice(0, 300)}`);
    }
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GoogleAuthError("Google token refresh returned no access_token");
    cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 - 60_000 };
    return body.access_token;
  };

  return {
    async getAccessToken({ forceRefresh = false } = {}) {
      if (!forceRefresh && cached && now() < cached.expiresAt) return cached.token;
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
