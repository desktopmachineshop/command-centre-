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
  // Sending goes through Graph (HTTPS): hosts like Railway block outgoing SMTP on lower plans.
  "https://graph.microsoft.com/Mail.Send",
];

/** An access token is for one API: Outlook's IMAP/SMTP, or Microsoft Graph (sending). */
export type MicrosoftResource = "outlook" | "graph";
const RESOURCE_SCOPES: Record<MicrosoftResource, string> = {
  outlook: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
  graph: "offline_access https://graph.microsoft.com/Mail.Send",
};

export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";

interface Options {
  fetch: typeof fetch;
  /** Base of the token endpoint (tests point it at a fake). */
  loginBase: string;
  /** Google's token endpoint, the Gmail API and Microsoft Graph (tests point them at fakes). */
  googleToken: string;
  gmailApi: string;
  graphApi: string;
  onRotate?: (accountId: string, refreshToken: string) => void;
}

let options: Options = {
  fetch: (input, init) => fetch(input, init),
  loginBase: MICROSOFT_LOGIN,
  googleToken: "https://oauth2.googleapis.com/token",
  gmailApi: "https://gmail.googleapis.com",
  graphApi: "https://graph.microsoft.com",
};

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

/** The newest refresh token per account (Microsoft rotates it on every swap, for any resource). */
const latestRefresh = new Map<string, { configured: string; refreshToken: string }>();

/** A current access token for an OAuth mailbox, for Outlook's IMAP/SMTP or for Graph. */
export async function accessTokenFor(account: EmailAccount, resource: MicrosoftResource = "outlook"): Promise<string> {
  const oauth = account.oauth;
  if (!oauth) throw new Error(`${account.id} doesn't use OAuth`);
  let latest = latestRefresh.get(account.id);
  if (!latest || latest.configured !== oauth.refreshToken) {
    latest = { configured: oauth.refreshToken, refreshToken: oauth.refreshToken };
    latestRefresh.set(account.id, latest);
  }
  const key = `${account.id}|${resource}`;
  let c = cache.get(key);
  if (!c || c.configured !== oauth.refreshToken) {
    c = { configured: oauth.refreshToken, refreshToken: oauth.refreshToken, expiresAt: 0 };
    cache.set(key, c);
  }
  if (c.accessToken && Date.now() < c.expiresAt - 60_000) return c.accessToken;
  if (c.pending) return c.pending;
  const entry = c;
  const current = latest;
  entry.pending = (async () => {
    try {
      const form: Record<string, string> = {
        client_id: oauth.clientId,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        scope: RESOURCE_SCOPES[resource],
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
      if (body.refresh_token && body.refresh_token !== current.refreshToken) {
        current.refreshToken = body.refresh_token;
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

// ---------- Sending over HTTPS (Gmail API, Microsoft Graph) ----------

const googleCache = new Map<string, { accessToken: string; expiresAt: number }>();

/** A Gmail API access token from the account's Google sign-in (`send`). */
export async function gmailAccessToken(account: EmailAccount): Promise<string> {
  const send = account.send;
  if (!send) throw new Error(`${account.id} doesn't send through Gmail`);
  const key = `${account.id}|${send.refreshToken}`;
  const hit = googleCache.get(key);
  if (hit && Date.now() < hit.expiresAt - 60_000) return hit.accessToken;
  const res = await options.fetch(options.googleToken, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: send.clientId, client_secret: send.clientSecret, refresh_token: send.refreshToken, grant_type: "refresh_token" }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    const why = body.error === "invalid_grant" ? "the Google sign-in has expired or was revoked; reconnect it on the Accounts page" : (body.error ?? `HTTP ${res.status}`);
    throw new EmailAuthError(`Google sign-in for sending from ${account.address} failed: ${why}`);
  }
  googleCache.set(key, { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/** How this account sends: the Gmail API, Microsoft Graph, or SMTP. */
export function sendRoute(account: EmailAccount): "gmail" | "graph" | "smtp" {
  if (account.send?.via === "gmail") return "gmail";
  if (account.oauth?.provider === "microsoft") return "graph";
  return "smtp";
}

/**
 * Sends a built RFC 822 message over HTTPS. Returns null for SMTP accounts (the caller uses
 * nodemailer). Both APIs file the message in Sent.
 */
export async function sendOverHttps(account: EmailAccount, raw: Buffer): Promise<{ id: string | null } | null> {
  const route = sendRoute(account);
  if (route === "gmail") {
    const res = await options.fetch(`${options.gmailApi}/gmail/v1/users/me/messages/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await gmailAccessToken(account)}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: raw.toString("base64url") }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`Gmail refused the message: ${(body.error?.message ?? `HTTP ${res.status}`).slice(0, 200)}`);
    return { id: body.id ?? null };
  }
  if (route === "graph") {
    const res = await options.fetch(`${options.graphApi}/v1.0/me/sendMail`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessTokenFor(account, "graph")}`, "content-type": "text/plain" },
      body: raw.toString("base64"),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Outlook refused the message: ${(body.error?.message ?? `HTTP ${res.status}`).slice(0, 200)}`);
    }
    return { id: null };
  }
  return null;
}

/** Checks the account can send over HTTPS (gets a token); false for SMTP accounts. */
export async function verifyHttpsSending(account: EmailAccount): Promise<boolean> {
  const route = sendRoute(account);
  if (route === "gmail") await gmailAccessToken(account);
  else if (route === "graph") await accessTokenFor(account, "graph");
  else return false;
  return true;
}
