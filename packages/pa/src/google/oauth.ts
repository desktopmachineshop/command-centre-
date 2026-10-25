/**
 * Google OAuth 2.0 access tokens from a long-lived refresh token, shared by
 * everything in the command centre that talks to Google (Calendar here, Drive
 * storage elsewhere). One OAuth client and one refresh token, from
 * `pnpm --filter @cc/pa google:auth`, cover every scope it asked for.
 *
 * Refresh-token grant: https://developers.google.com/identity/protocols/oauth2/native-app#offline
 * Token expiry rules: https://developers.google.com/identity/protocols/oauth2#expiration
 *
 * Import with `import { createGoogleTokenProvider } from "@cc/pa/google-oauth"`.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Env names shared by every Google integration. */
export const GOOGLE_ENV = { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET", refreshToken: "GOOGLE_REFRESH_TOKEN" } as const;

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** How Dave gets a new refresh token, quoted in every auth failure. */
export const REAUTH_HINT =
  'Reconnect it on the Accounts page (Google account → Connect). If the OAuth consent screen is still in "Testing", Google expires refresh tokens after 7 days: publish the app to stop that (docs/SETUP.md, "Personal assistant").';

/** Google refused the credentials: a revoked or expired refresh token, or a wrong client. Reconnect on the Accounts page. */
export class GoogleAuthError extends Error {
  constructor(
    message: string,
    /** Google's error code, e.g. invalid_grant. */
    readonly code: string,
  ) {
    super(message);
  }
}

/** Any other token failure (network, Google 5xx). Worth retrying later. */
export class GoogleTokenError extends Error {}

export interface GoogleTokenProvider {
  /** A valid access token, cached and refreshed a minute before it expires. */
  getAccessToken(): Promise<string>;
  /** Drops the cached token (after an API 401), so the next call refreshes. */
  invalidate(): void;
}

/**
 * Exchanges the refresh token for access tokens as needed. Concurrent callers
 * share one refresh. `label` names the integration in errors (never a secret).
 */
export function createGoogleTokenProvider(options: GoogleOAuthCredentials & { fetch?: typeof fetch; now?: () => number; label?: string }): GoogleTokenProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const label = options.label ? ` for ${options.label}` : "";
  let token: { value: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const refresh = async (): Promise<string> => {
    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          refresh_token: options.refreshToken,
          grant_type: "refresh_token",
        }),
      });
    } catch (err) {
      throw new GoogleTokenError(`Google token refresh${label} failed: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const why = [body.error, body.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`;
      if (body.error === "invalid_grant") {
        throw new GoogleAuthError(`Google rejected the refresh token${label} (${why}): it has expired or been revoked. ${REAUTH_HINT}`, body.error);
      }
      if (body.error === "invalid_client" || body.error === "unauthorized_client") {
        throw new GoogleAuthError(
          `Google rejected the OAuth client${label} (${why}). Check the client id and secret (Accounts page → Developer apps → Google OAuth client); the refresh token must come from that same client. ${REAUTH_HINT}`,
          body.error,
        );
      }
      throw new GoogleTokenError(`Google token refresh${label} failed (${why})`);
    }
    token = { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  };

  return {
    async getAccessToken() {
      if (token && token.expiresAt - 60_000 > now()) return token.value;
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      token = null;
    },
  };
}

/** The shared credentials from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN, if all three are set. */
export function googleCredentialsFromEnv(env: Record<string, string | undefined> = process.env): GoogleOAuthCredentials | null {
  const clientId = env[GOOGLE_ENV.clientId]?.trim();
  const clientSecret = env[GOOGLE_ENV.clientSecret]?.trim();
  const refreshToken = env[GOOGLE_ENV.refreshToken]?.trim();
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}
