import type { EmailAccount } from "./accounts";

/**
 * Microsoft (Outlook.com, Hotmail, Live, Microsoft 365) mailboxes sign in with OAuth 2.0
 * (XOAUTH2), not passwords: Microsoft turned off password sign-in for IMAP and SMTP. The account
 * holds a refresh token; this swaps it for short-lived access tokens, cached per account.
 * Microsoft hands back a new refresh token on each swap: the newest is kept in memory and
 * passed to `onRotate` so it can be saved.
 */
export const MICROSOFT_MAIL_SCOPES = [
  "offline_access",
  "openid",
  "email",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
];

export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";

interface Options {
  fetch: typeof fetch;
  /** Base of the token endpoint (tests point it at a fake). */
  loginBase: string;
  onRotate?: (accountId: string, refreshToken: string) => void;
}

let options: Options = { fetch: (input, init) => fetch(input, init), loginBase: MICROSOFT_LOGIN };

/** Server wiring: where rotated refresh tokens go, and (tests) a fake fetch. */
export function configureEmailOAuth(next: Partial<Options>): void {
  options = { ...options, ...next };
}

interface Cached {
  /** The refresh token the account was configured with; a new one (reconnect) resets the cache. */
  configured: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt: number;
  pending?: Promise<string>;
}
const cache = new Map<string, Cached>();

export class EmailAuthError extends Error {}

/** A current access token for an OAuth mailbox. */
export async function accessTokenFor(account: EmailAccount): Promise<string> {
  const oauth = account.oauth;
  if (!oauth) throw new Error(`${account.id} doesn't use OAuth`);
  let c = cache.get(account.id);
  if (!c || c.configured !== oauth.refreshToken) {
    c = { configured: oauth.refreshToken, refreshToken: oauth.refreshToken, expiresAt: 0 };
    cache.set(account.id, c);
  }
  if (c.accessToken && Date.now() < c.expiresAt - 60_000) return c.accessToken;
  if (c.pending) return c.pending;
  const entry = c;
  entry.pending = (async () => {
    try {
      const form: Record<string, string> = {
        client_id: oauth.clientId,
        grant_type: "refresh_token",
        refresh_token: entry.refreshToken,
        scope: MICROSOFT_MAIL_SCOPES.join(" "),
      };
      if (oauth.clientSecret) form.client_secret = oauth.clientSecret;
      const res = await options.fetch(`${options.loginBase}/${encodeURIComponent(oauth.tenant)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
      if (!res.ok || !body.access_token) {
        const why = body.error === "invalid_grant" ? "the sign-in has expired or was revoked; reconnect it on the Accounts page" : (body.error ?? `HTTP ${res.status}`);
        throw new EmailAuthError(`Microsoft sign-in for ${account.address} failed: ${why}`);
      }
      entry.accessToken = body.access_token;
      entry.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
      if (body.refresh_token && body.refresh_token !== entry.refreshToken) {
        entry.refreshToken = body.refresh_token;
        try {
          options.onRotate?.(account.id, body.refresh_token);
        } catch {
          // saving is best-effort; the in-memory token keeps working
        }
      }
      return body.access_token;
    } finally {
      entry.pending = undefined;
    }
  })();
  return entry.pending;
}

/** imapflow's `auth`: a password, or an XOAUTH2 access token. */
export async function imapAuth(account: EmailAccount): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (account.oauth) return { user: account.imap.user, accessToken: await accessTokenFor(account) };
  return { user: account.imap.user, pass: account.imap.pass };
}

/** nodemailer's `auth`: a password, or an OAuth2 access token. */
export async function smtpAuth(account: EmailAccount): Promise<{ user: string; pass?: string } | { type: "OAuth2"; user: string; accessToken: string }> {
  if (account.oauth) return { type: "OAuth2", user: account.smtp.user, accessToken: await accessTokenFor(account) };
  return { user: account.smtp.user, pass: account.smtp.pass };
}
