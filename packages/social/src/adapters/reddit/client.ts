import { createHash } from "node:crypto";
import type { AdapterContext } from "../../types";

/**
 * Minimal Reddit Data API client for one account: a "web app" signed in on the Accounts page
 * (refresh-token grant), or a "script" app (password grant).
 * - Token: POST https://www.reddit.com/api/v1/access_token (Basic client_id:client_secret,
 *   grant_type=refresh_token or password); tokens last an hour and are refreshed 5 minutes early.
 * - Calls: https://oauth.reddit.com with `Authorization: bearer <token>` and the account's
 *   User-Agent (`<platform>:<app id>:<version> (by /u/<username>)`).
 * - Rate limit: honours X-Ratelimit-Remaining / X-Ratelimit-Reset.
 * Errors never contain the client secret, password or token.
 */

export const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const REDDIT_API = "https://oauth.reddit.com";

const REFRESH_EARLY_MS = 5 * 60_000;
/** Wait at most this long for the rate-limit window to reset inside one call. */
const MAX_RATE_WAIT_MS = 60_000;

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  /** The account's name (without u/); from the account's handle when signed in with Connect. */
  username: string;
  /** Password grant (script app). */
  password?: string;
  /** Refresh-token grant (web app, from the Accounts page sign-in). Wins over the password. */
  refreshToken?: string;
  userAgent: string;
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RedditApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Reddit error codes from `json.errors`, e.g. ["RATELIMIT"]. */
    readonly codes: string[] = [],
  ) {
    super(message);
    this.name = "RedditApiError";
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class RedditClient {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();
  /** Per-credential epoch ms until which we hold off (rate-limit window used up). */
  private readonly holdUntil = new Map<string, number>();

  constructor(private readonly sleep: Sleep = realSleep) {}

  private key(c: RedditCredentials): string {
    if (c.username) return `${c.clientId}:${c.username.toLowerCase()}`;
    return `${c.clientId}:rt:${createHash("sha256").update(c.refreshToken ?? "").digest("hex").slice(0, 16)}`;
  }

  /** A valid access token, from cache when it has more than 5 minutes left. */
  async token(ctx: AdapterContext, c: RedditCredentials): Promise<string> {
    const key = this.key(c);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_EARLY_MS > ctx.now().getTime()) return cached.token;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = this.grant(ctx, c).finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  invalidate(c: RedditCredentials): void {
    this.tokens.delete(this.key(c));
  }

  private async grant(ctx: AdapterContext, c: RedditCredentials): Promise<string> {
    const body = c.refreshToken
      ? new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refreshToken })
      : new URLSearchParams({ grant_type: "password", username: c.username, password: c.password ?? "" });
    const res = await ctx.fetch(REDDIT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
        "User-Agent": c.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: ctx.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string | number;
    };
    if (!res.ok || !data.access_token) {
      const reason = typeof data.error === "string" || typeof data.error === "number" ? String(data.error) : `HTTP ${res.status}`;
      let hint = "";
      if (res.status === 401) hint = ` - check clientId/clientSecret (the ${c.refreshToken ? "web" : "script"} app at reddit.com/prefs/apps)`;
      else if (reason === "invalid_grant") {
        hint = c.refreshToken
          ? " - the sign-in was revoked or has expired; reconnect it on the Accounts page"
          : " - check username/password; the password grant doesn't work for accounts with two-factor auth";
      } else if (res.status === 429) hint = " - rate limited; try again later";
      throw new RedditApiError(`Reddit login failed for ${c.username ? `u/${c.username}` : "the account"}: ${reason}${hint}`, res.status);
    }
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.tokens.set(this.key(c), { token: data.access_token, expiresAt: ctx.now().getTime() + expiresIn * 1000 });
    return data.access_token;
  }

  /**
   * Call the API. `form` sends a POST with an urlencoded body (always with `api_type=json`);
   * otherwise a GET with `query`. 401 refreshes the token once.
   */
  async call<T>(
    ctx: AdapterContext,
    c: RedditCredentials,
    path: string,
    opts: { form?: Record<string, string | undefined>; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const key = this.key(c);
    for (let attempt = 0; ; attempt++) {
      const hold = (this.holdUntil.get(key) ?? 0) - ctx.now().getTime();
      if (hold > 0) {
        if (hold > MAX_RATE_WAIT_MS) {
          throw new RedditApiError(`Reddit API rate limit reached; resets in ${Math.ceil(hold / 1000)}s`, 429, ["RATELIMIT"]);
        }
        await this.sleep(hold);
      }
      const token = await this.token(ctx, c);
      const url = new URL(`${REDDIT_API}${path}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
      const form = opts.form ? new URLSearchParams() : undefined;
      if (form) {
        form.set("api_type", "json");
        for (const [k, v] of Object.entries(opts.form!)) if (v !== undefined) form.set(k, v);
      }
      const res = await ctx.fetch(url.toString(), {
        method: form ? "POST" : "GET",
        headers: {
          Authorization: `bearer ${token}`,
          "User-Agent": c.userAgent,
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form?.toString(),
        signal: ctx.signal,
      });
      this.trackRateLimit(key, res, ctx);

      if (res.status === 401 && attempt === 0) {
        this.invalidate(c);
        continue;
      }
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        throw new RedditApiError(
          `Reddit API rate limit reached${Number.isFinite(reset) ? `; resets in ${Math.ceil(reset)}s` : ""}`,
          429,
          ["RATELIMIT"],
        );
      }
      const data = (await res.json().catch(() => null)) as T | null;
      if (!res.ok) {
        const msg = (data as { message?: string; reason?: string } | null)?.reason ?? (data as { message?: string } | null)?.message ?? res.statusText;
        let hint = "";
        if (res.status === 403) hint = " - the subreddit may be private or quarantined, the account banned there, or the app lacks a scope";
        if (res.status === 404) hint = " - not found (check the subreddit name or thing id)";
        throw new RedditApiError(`Reddit API ${res.status} on ${path}: ${msg}${hint}`, res.status);
      }
      if (data === null) throw new RedditApiError(`Reddit API returned an unreadable response on ${path}`, res.status);
      throwJsonErrors(data, path);
      return data;
    }
  }

  private trackRateLimit(key: string, res: Response, ctx: AdapterContext): void {
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (res.headers.has("x-ratelimit-remaining") && remaining < 1 && Number.isFinite(reset)) {
      this.holdUntil.set(key, ctx.now().getTime() + reset * 1000);
    } else this.holdUntil.delete(key);
  }
}

type JsonErrors = { json?: { errors?: [string, string, string?][] } };

/** Turn Reddit's `{json: {errors: [[CODE, message, field], ...]}}` into a clear error. */
export function throwJsonErrors(data: unknown, path: string): void {
  const errors = (data as JsonErrors)?.json?.errors;
  if (!Array.isArray(errors) || !errors.length) return;
  const codes = errors.map((e) => String(e[0]));
  const messages = errors.map(([code, message, field]) => describeError(String(code), message, field));
  throw new RedditApiError(`Reddit rejected ${path}: ${messages.join("; ")}`, 200, codes);
}

function describeError(code: string, message: string, field?: string): string {
  switch (code) {
    case "RATELIMIT":
      return `rate limited by Reddit (${message}); the account is posting too often, wait before retrying`;
    case "BAD_CAPTCHA":
      return "Reddit asked for a captcha, which the Command Centre never solves; post this one by hand on Reddit";
    case "USER_REQUIRED":
      return "Reddit says the account isn't signed in; reconnect Reddit on the Accounts page";
    case "SUBREDDIT_NOEXIST":
      return "that subreddit doesn't exist (check content.target, without the r/)";
    case "SUBREDDIT_NOTALLOWED":
    case "SUBREDDIT_NO_ACCESS":
      return "this account isn't allowed to post in that subreddit (private, restricted or banned)";
    case "SUBMIT_VALIDATION_FLAIR_REQUIRED":
      return "that subreddit requires a post flair; set content.options.flairId (see the subreddit's flair list)";
    case "NO_SELFS":
      return "that subreddit doesn't allow text posts; post a link instead";
    case "NO_LINKS":
      return "that subreddit doesn't allow link posts; post text instead";
    case "ALREADY_SUB":
      return "that link was already submitted there (set content.options.resubmit to post it again)";
    case "TOO_LONG":
      return `${field ?? "a field"} is too long (${message})`;
    case "NO_TEXT":
      return `${field ?? "a field"} is required`;
    case "BAD_SR_NAME":
      return "invalid subreddit name";
    case "USER_DOESNT_EXIST":
      return "that user doesn't exist";
    case "NOT_WHITELISTED_BY_USER_MESSAGE":
      return "that user only accepts messages from people they've approved";
    case "THREAD_LOCKED":
    case "TOO_OLD":
      return "that thread is locked or archived, so it can't be replied to";
    case "DELETED_COMMENT":
    case "DELETED_LINK":
      return "the thing being replied to was deleted";
    default:
      return `${code}: ${message}${field ? ` (${field})` : ""}`;
  }
}
