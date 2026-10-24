import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_TOKEN_URL, redact, YOUTUBE_API } from "./client";

/**
 * The pieces of Google's OAuth 2.0 flow for installed apps
 * (https://developers.google.com/identity/protocols/oauth2/native-app) that `youtube:auth` uses:
 * a loopback redirect (`http://127.0.0.1:<port>`), PKCE (S256), `access_type=offline` and
 * `prompt=consent` so Google returns a refresh token. Kept free of I/O except the injected fetch,
 * so it can be tested without a browser.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const YOUTUBE_SCOPES = [
  // videos.insert and thumbnails.set
  "https://www.googleapis.com/auth/youtube.upload",
  // commentThreads.list, comments.insert (and reading the channel's videos)
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  scope: string[];
  expiresIn: number;
}

/** Exchanges the authorization code for tokens. Throws (redacted) if Google returns no refresh token. */
export async function exchangeCode(
  fetchFn: typeof fetch,
  opts: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      code_verifier: opts.verifier,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  const secrets = [opts.clientSecret, opts.code, opts.verifier];
  if (!res.ok || !data.access_token) {
    throw new Error(redact(`Google refused the code: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ""}`, secrets));
  }
  if (!data.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Remove the app's access at https://myaccount.google.com/permissions and run this again " +
        "(the flow already asks for prompt=consent and access_type=offline).",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: (data.scope ?? "").split(" ").filter(Boolean),
    expiresIn: data.expires_in ?? 3600,
  };
}

/** The channel the token belongs to (`channels.list?mine=true`, 1 quota unit). */
export async function fetchOwnChannels(fetchFn: typeof fetch, accessToken: string): Promise<{ id: string; title: string; customUrl?: string }[]> {
  const res = await fetchFn(`${YOUTUBE_API}/channels?part=snippet&mine=true&maxResults=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json().catch(() => ({}))) as {
    items?: { id: string; snippet?: { title?: string; customUrl?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(redact(`Couldn't list the account's channels: ${data.error?.message ?? res.status}`, [accessToken]));
  return (data.items ?? []).map((i) => ({ id: i.id, title: i.snippet?.title ?? i.id, customUrl: i.snippet?.customUrl }));
}
