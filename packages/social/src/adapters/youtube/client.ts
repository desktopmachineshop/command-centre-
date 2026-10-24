import type { AdapterContext } from "../../types";

/**
 * Minimal YouTube Data API v3 client for one channel (OAuth 2.0 with a refresh token).
 *
 * - Token: `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`. Access
 *   tokens last about an hour; they are cached per (clientId, refresh token) and refreshed
 *   5 minutes early or after a 401.
 * - Calls: `https://www.googleapis.com/youtube/v3/...` (and `/upload/youtube/v3/...` for media)
 *   with `Authorization: Bearer <token>`.
 * - Errors: Google's `{ error: { code, message, errors: [{ reason, domain, message }] } }` become a
 *   `YouTubeApiError` with the first `reason` (e.g. `quotaExceeded`) and a message Dave can act on.
 * - Secrets (client secret, refresh token, access tokens, upload session ids) never appear in an
 *   error or log line.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

const REFRESH_EARLY_MS = 5 * 60_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  channelId: string;
}

export type YouTubeErrorKind = "quota" | "rate_limit" | "auth" | "permission" | "not_found" | "invalid" | "server" | "network";

export class YouTubeApiError extends Error {
  constructor(
    message: string,
    readonly kind: YouTubeErrorKind,
    readonly status?: number,
    /** Google's error reason, e.g. "quotaExceeded", "uploadLimitExceeded", "commentsDisabled". */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

/** Replace every secret (and its URL-encoded form) in `text`, plus bearer tokens and upload ids. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join("[redacted]");
  }
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bya29\.[A-Za-z0-9._~+/=-]+/g, "[redacted]")
    .replace(/\b1\/\/[A-Za-z0-9._~+/=-]{10,}/g, "[redacted]")
    .replace(/(upload_id=)[^&\s"']+/gi, "$1[redacted]");
}

interface GoogleErrorBody {
  error?:
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: { reason?: string; domain?: string; message?: string }[];
      }
    | string;
  error_description?: string;
}

/** Messages for the reasons Dave is likely to meet. Others fall back to Google's message. */
const REASON_HINTS: Record<string, { kind: YouTubeErrorKind; hint: string }> = {
  quotaExceeded: {
    kind: "quota",
    hint:
      "the YouTube API daily quota for this Google Cloud project is used up. Quota resets at midnight Pacific Time; " +
      "uploads have their own bucket (100 per day by default) and other calls share 10,000 units per day. Retry after the reset, " +
      "or request more quota in the Google Cloud console",
  },
  dailyLimitExceeded: { kind: "quota", hint: "the project's daily API limit is used up; retry after midnight Pacific Time" },
  uploadLimitExceeded: {
    kind: "quota",
    hint: "the channel has hit YouTube's own upload limit (a per-channel limit, separate from API quota); try again in 24 hours",
  },
  rateLimitExceeded: { kind: "rate_limit", hint: "too many requests in a short time; wait a minute and retry" },
  userRateLimitExceeded: { kind: "rate_limit", hint: "too many requests in a short time; wait a minute and retry" },
  insufficientPermissions: {
    kind: "permission",
    hint: "the refresh token lacks a scope. Run `pnpm --filter @cc/social youtube:auth` again and grant both youtube.upload and youtube.force-ssl",
  },
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: {
    kind: "permission",
    hint: "the refresh token lacks a scope. Run `pnpm --filter @cc/social youtube:auth` again and grant both youtube.upload and youtube.force-ssl",
  },
  forbidden: { kind: "permission", hint: "YouTube refused the request for this channel" },
  commentsDisabled: { kind: "permission", hint: "comments are turned off on that video" },
  operationNotSupported: { kind: "permission", hint: "YouTube doesn't allow that comment operation (the author may need a Google+ style channel)" },
  processingFailure: { kind: "server", hint: "YouTube couldn't process the comment; retry later" },
  parentCommentIsPrivate: { kind: "permission", hint: "the comment being replied to is private or held for review" },
  commentTextTooLong: { kind: "invalid", hint: "the reply text is too long" },
  invalidTitle: { kind: "invalid", hint: "the title is empty or invalid (max 100 characters, no < or >)" },
  invalidDescription: { kind: "invalid", hint: "the description is invalid (max 5000 bytes, no < or >)" },
  invalidTags: { kind: "invalid", hint: "the tags are invalid (500 characters in all, counting commas and quotes)" },
  invalidCategoryId: { kind: "invalid", hint: "categoryId isn't a valid YouTube category (e.g. 28 Science & Technology, 26 Howto & Style)" },
  invalidPublishAt: { kind: "invalid", hint: "publishAt is invalid; it needs privacyStatus \"private\" and an ISO 8601 time" },
  forbiddenPrivacySetting: { kind: "invalid", hint: "that privacy setting isn't allowed for this video" },
  invalidImage: { kind: "invalid", hint: "the thumbnail image is invalid (JPEG or PNG, max 50 MB; 1280x720 recommended)" },
  mediaBodyRequired: { kind: "invalid", hint: "the upload had no video content" },
  videoNotFound: { kind: "not_found", hint: "that video doesn't exist or isn't visible to this channel" },
  commentNotFound: { kind: "not_found", hint: "that comment no longer exists" },
  channelNotFound: { kind: "not_found", hint: "the channel wasn't found; check credentials.channelId" },
};

/** Builds a `YouTubeApiError` from a failed response, without leaking secrets. */
export async function toYouTubeError(res: Response, what: string, secrets: readonly string[]): Promise<YouTubeApiError> {
  const raw = await res.text().catch(() => "");
  let body: GoogleErrorBody | undefined;
  try {
    body = raw ? (JSON.parse(raw) as GoogleErrorBody) : undefined;
  } catch {
    body = undefined;
  }
  const err = typeof body?.error === "object" ? body.error : undefined;
  const reason = err?.errors?.find((e) => e.reason)?.reason ?? (err?.status === "PERMISSION_DENIED" && /scope/i.test(err.message ?? "") ? "ACCESS_TOKEN_SCOPE_INSUFFICIENT" : undefined);
  const googleMessage = err?.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? raw.slice(0, 300).trim();
  const known = reason ? REASON_HINTS[reason] : undefined;

  let kind: YouTubeErrorKind = known?.kind ?? "invalid";
  let message: string;
  if (known) message = `YouTube couldn't ${what}: ${known.hint}.`;
  else if (res.status === 401) {
    kind = "auth";
    message = `YouTube rejected the access token while trying to ${what} (401).`;
  } else if (res.status === 403) {
    kind = "permission";
    message = `YouTube refused to ${what} (403).`;
  } else if (res.status === 404) {
    kind = "not_found";
    message = `YouTube couldn't ${what}: not found (404).`;
  } else if (res.status === 429) {
    kind = "rate_limit";
    message = `YouTube rate limit reached while trying to ${what}; wait and retry.`;
  } else if (res.status >= 500) {
    kind = "server";
    message = `YouTube had a server error (${res.status}) while trying to ${what}; retry later.`;
  } else message = `YouTube API error ${res.status} while trying to ${what}.`;
  if (googleMessage && !message.includes(googleMessage)) message += ` YouTube said: ${googleMessage}${reason && !known ? ` (${reason})` : ""}`;
  return new YouTubeApiError(redact(message, secrets), kind, res.status, reason);
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  json?: unknown;
  body?: RequestInit["body"];
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** A signal that fires on the context's abort or after `ms`. */
export function withTimeout(ctx: AdapterContext, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

export class YouTubeClient {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();
  /** The last few access tokens we were issued, so they can be scrubbed from any message. */
  private readonly issued: string[] = [];

  private key(c: YouTubeCredentials): string {
    return `${c.clientId}\u0000${c.refreshToken}`;
  }

  /** Everything that must never be shown for these credentials. */
  secrets(c: YouTubeCredentials): string[] {
    const cached = this.tokens.get(this.key(c))?.token;
    return [c.clientSecret, c.refreshToken, ...(cached ? [cached] : []), ...this.issued];
  }

  /** A valid access token, from cache while it has more than 5 minutes left. */
  async token(ctx: AdapterContext, c: YouTubeCredentials): Promise<string> {
    const key = this.key(c);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_EARLY_MS > ctx.now().getTime()) return cached.token;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = this.refresh(ctx, c).finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  invalidate(c: YouTubeCredentials): void {
    this.tokens.delete(this.key(c));
  }

  private async refresh(ctx: AdapterContext, c: YouTubeCredentials): Promise<string> {
    const body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    });
    let res: Response;
    try {
      res = await ctx.fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: withTimeout(ctx, DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new YouTubeApiError(redact(`Couldn't reach Google to refresh the YouTube token: ${(err as Error).message}`, this.secrets(c)), "network");
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      const reason = data.error ?? `HTTP ${res.status}`;
      let hint = "";
      if (reason === "invalid_grant") {
        hint =
          " - the refresh token was revoked or has expired. Run `pnpm --filter @cc/social youtube:auth` again and update SOCIAL_ACCOUNTS. " +
          "If the OAuth consent screen is still in \"Testing\", Google expires refresh tokens after 7 days: publish the app (In production) to stop that";
      } else if (reason === "invalid_client" || reason === "unauthorized_client") {
        hint = " - check clientId and clientSecret (Google Cloud console → APIs & Services → Credentials)";
      }
      const desc = data.error_description ? ` (${data.error_description})` : "";
      throw new YouTubeApiError(redact(`YouTube token refresh failed: ${reason}${desc}${hint}`, this.secrets(c)), "auth", res.status, data.error);
    }
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.issued.push(data.access_token);
    if (this.issued.length > 10) this.issued.shift();
    this.tokens.set(this.key(c), { token: data.access_token, expiresAt: ctx.now().getTime() + expiresIn * 1000 });
    return data.access_token;
  }

  /**
   * One authenticated request. A 401 refreshes the token and retries once. Returns the raw
   * response when it is OK (or one of `okStatuses`); otherwise throws a `YouTubeApiError`.
   */
  async raw(
    ctx: AdapterContext,
    c: YouTubeCredentials,
    method: string,
    url: string,
    what: string,
    opts: RequestOptions = {},
    okStatuses: number[] = [],
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(ctx, c);
      const u = new URL(url);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...opts.headers };
      let body = opts.body;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json; charset=UTF-8";
        body = JSON.stringify(opts.json);
      }
      let res: Response;
      try {
        res = await ctx.fetch(u.toString(), { method, headers, body, signal: withTimeout(ctx, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
      } catch (err) {
        throw new YouTubeApiError(redact(`Couldn't reach YouTube to ${what}: ${(err as Error).message}`, this.secrets(c)), "network");
      }
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        this.invalidate(c);
        continue;
      }
      if (res.ok || okStatuses.includes(res.status)) return res;
      throw await toYouTubeError(res, what, this.secrets(c));
    }
  }

  /** `raw` plus JSON parsing. */
  async json<T>(ctx: AdapterContext, c: YouTubeCredentials, method: string, url: string, what: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(ctx, c, method, url, what, opts);
    const data = (await res.json().catch(() => null)) as T | null;
    if (data === null) throw new YouTubeApiError(`YouTube returned an unreadable response while trying to ${what}`, "server", res.status);
    return data;
  }
}
