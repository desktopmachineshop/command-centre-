import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_SCOPES } from "./calendar/google";
import { GOOGLE_TOKEN_URL } from "./google/oauth";

/** Drive storage (another integration) shares the token: only files the app creates or is given. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** What google:auth asks for by default: the calendar scopes plus drive.file, so one token serves both. */
export const DEFAULT_AUTH_SCOPES = [...GOOGLE_SCOPES, DRIVE_FILE_SCOPE];

/** Parses `--scopes a,b` (full URLs, or short names like calendar.events, drive.file). */
export function parseScopes(value: string | undefined): string[] {
  if (!value?.trim()) return DEFAULT_AUTH_SCOPES;
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => (s.startsWith("https://") ? s : `https://www.googleapis.com/auth/${s}`));
}

/**
 * The one-off OAuth 2.0 loopback flow with PKCE that gets a refresh token
 * (https://developers.google.com/identity/protocols/oauth2/native-app).
 * `src/cli/google-auth.ts` runs it on Dave's PC; these pieces are testable.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string; scopes?: string[] }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: (p.scopes ?? DEFAULT_AUTH_SCOPES).join(" "),
    // offline + consent: Google returns a refresh token every time, not only on first consent.
    access_type: "offline",
    prompt: "consent",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  p: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; accessToken: string; scope: string }> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code: p.code,
      code_verifier: p.verifier,
      grant_type: "authorization_code",
      redirect_uri: p.redirectUri,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) throw new Error(`Token exchange failed: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  if (!body.refresh_token) throw new Error("Google returned no refresh token. Remove the app's access at https://myaccount.google.com/permissions and run this again.");
  return { refreshToken: body.refresh_token, accessToken: body.access_token!, scope: body.scope ?? "" };
}

/** The calendars the account can see, so Dave can copy ids of shared and family calendars. */
export async function listCalendars(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; summary: string; primary: boolean; accessRole: string }[]> {
  const res = await fetchImpl("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[] };
  return (body.items ?? []).map((c) => ({ id: c.id, summary: c.summaryOverride ?? c.summary ?? c.id, primary: !!c.primary, accessRole: c.accessRole ?? "reader" }));
}
