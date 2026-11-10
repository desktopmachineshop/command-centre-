import { createHash } from "node:crypto";
import { type OldRedditMe, readMe, readRedirect, refusedMessage } from "@cc/core";
import type { AdapterContext } from "../../types";
import { realSleep, RedditApiError, type Sleep, throwJsonErrors } from "./client";

/**
 * Session mode: Dave's own Reddit account, signed in as a normal user, with no developer app.
 * He copies the `reddit_session` cookie from his browser once (docs/SETUP.md, "Reddit without a
 * developer app"); the server sends it to old.reddit.com's own endpoints, the ones the website's
 * forms use:
 * - `GET /api/me.json` -> the username, karma and the `modhash` (old Reddit's CSRF token); a
 *   signed-out session is redirected to `/login` instead (seen November 2026), or gets `{}`;
 * - `POST /api/comment`, `/api/submit`, `/api/compose` with `uh=<modhash>` and `X-Modhash`;
 * - `GET /message/inbox.json`, `/message/sent.json`, `/api/info.json`.
 * The paths and bodies are the same as the Data API's, so the adapter is shared.
 *
 * This is automation of a personal account outside Reddit's official API, which Reddit's terms
 * may not allow; whether to use it is Dave's call. It does nothing to hide that: the User-Agent
 * names the Command Centre, there is one account, requests are serial and paced, and when Reddit
 * refuses (a block page, a captcha, a rate limit) the call fails with that reason. Nothing here
 * solves captchas, rotates addresses or imitates a browser.
 */

export const REDDIT_OLD = "https://old.reddit.com";

const MODHASH_TTL_MS = 10 * 60_000;
const MAX_RATE_WAIT_MS = 60_000;

export interface RedditSessionCredentials {
  mode: "session";
  /** The `reddit_session` cookie's value. */
  session: string;
  /** The `token_v2` cookie's value, sent alongside when given (Reddit's newer session token). */
  tokenV2?: string;
  /** The account's name (without u/); empty until `/api/me.json` has said. */
  username: string;
  userAgent: string;
}

/** The saved session no longer signs in: Dave has to paste a fresh cookie. */
export class RedditSessionExpiredError extends RedditApiError {
  /** Tells the server to raise its "reconnect on the Accounts page" alert. */
  readonly reconnect = true;
  constructor(username?: string) {
    super(
      `Reddit no longer accepts the saved session${username ? ` for u/${username}` : ""} (signed out, expired, or the password changed). Reconnect Reddit on the Accounts page: paste a fresh reddit_session cookie.`,
      401,
      ["USER_REQUIRED"],
    );
    this.name = "RedditSessionExpiredError";
  }
}

const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/; // RFC 6265 cookie-octet: no spaces, quotes, commas, semicolons or backslashes

/**
 * What Dave pasted, as cookie values: the bare `reddit_session` value, `reddit_session=<value>`,
 * or a whole `Cookie:` header copied from the browser's dev tools (from which `reddit_session`
 * and `token_v2` are taken). Throws a message that never echoes the value.
 */
export function parseSessionCookie(raw: string, tokenV2?: string): { session: string; tokenV2?: string } {
  const text = raw.trim().replace(/^cookie:\s*/i, "");
  const pick = (name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;\\s]+)`).exec(text)?.[1];
  let session = pick("reddit_session");
  if (!session) {
    if (/[=;]/.test(text) && /(^|;\s*)[\w.-]+=/.test(text)) throw new Error("no reddit_session cookie in what was pasted (copy the value of the cookie named reddit_session)");
    session = text;
  }
  const strip = (v: string) => v.replace(/^"|"$/g, "");
  session = strip(session);
  const token = strip((tokenV2 ?? "").trim().replace(/^token_v2=/, "")) || pick("token_v2");
  if (!COOKIE_VALUE.test(session)) throw new Error("the reddit_session value has spaces or characters a cookie can't hold (copy just the Value column)");
  if (session.length < 20) throw new Error("the reddit_session value is too short to be a session cookie");
  if (token && !COOKIE_VALUE.test(token)) throw new Error("the token_v2 value has characters a cookie can't hold");
  return { session, ...(token ? { tokenV2: token } : {}) };
}

/** The `Cookie` header for a session. */
export function sessionCookieHeader(c: Pick<RedditSessionCredentials, "session" | "tokenV2">): string {
  return `reddit_session=${c.session}${c.tokenV2 ? `; token_v2=${c.tokenV2}` : ""}`;
}

/** Who the session signs in as (old.reddit.com's /api/me.json, read by @cc/core `readMe`). */
export type RedditSessionUser = OldRedditMe;

/**
 * The error for a request Reddit answered with a non-2xx status, in session and browser mode
 * alike. `where` names what Reddit may be blocking ("this server", "this PC").
 */
export function httpError(status: number, data: unknown, path: string, statusText: string, where: string): RedditApiError {
  const msg = (data as { reason?: string } | null)?.reason ?? (data as { message?: string } | null)?.message ?? statusText;
  let hint = "";
  if (status === 403) hint = ` - the subreddit may be private or quarantined, the account banned there, or Reddit is blocking ${where}`;
  if (status === 404) hint = " - not found (check the subreddit name or thing id)";
  return new RedditApiError(`Reddit ${status} on ${path}: ${msg}${hint}`, status);
}

/** Reddit answered with a page (a block or a captcha) where data was expected. */
export function pageError(path: string, status: number, posting: boolean, where: string): RedditApiError {
  const what = posting ? "check the account on Reddit before sending it again" : "nothing was read";
  return new RedditApiError(`Reddit answered ${path} with a page instead of data (it may be asking for a captcha or blocking ${where}); ${what}`, status);
}

export class RedditSessionClient {
  private readonly users = new Map<string, { user: RedditSessionUser; at: number }>();
  private readonly holdUntil = new Map<string, number>();
  /** One request at a time per session, as a person's browser tab would make them. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sleep: Sleep = realSleep,
    private readonly baseUrl = REDDIT_OLD,
  ) {}

  private key(c: RedditSessionCredentials): string {
    return createHash("sha256").update(c.session).digest("hex").slice(0, 16);
  }

  private headers(c: RedditSessionCredentials): Record<string, string> {
    return { Cookie: sessionCookieHeader(c), "User-Agent": c.userAgent, Accept: "application/json" };
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(key, run.catch(() => {}));
    return run;
  }

  private async send(ctx: AdapterContext, c: RedditSessionCredentials, url: string, init: RequestInit): Promise<Response> {
    const key = this.key(c);
    const hold = (this.holdUntil.get(key) ?? 0) - ctx.now().getTime();
    if (hold > 0) {
      if (hold > MAX_RATE_WAIT_MS) throw new RedditApiError(`Reddit rate limit reached; resets in ${Math.ceil(hold / 1000)}s`, 429, ["RATELIMIT"]);
      await this.sleep(hold);
    }
    // Redirects are not followed: old Reddit answers a signed-out session with a redirect to its login page.
    const res = await ctx.fetch(url, { ...init, redirect: "manual", headers: { ...this.headers(c), ...(init.headers as Record<string, string> | undefined) }, signal: ctx.signal });
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (res.headers.has("x-ratelimit-remaining") && remaining < 1 && Number.isFinite(reset)) this.holdUntil.set(key, ctx.now().getTime() + reset * 1000);
    else this.holdUntil.delete(key);
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || reset || 60;
      this.holdUntil.set(key, ctx.now().getTime() + wait * 1000);
      throw new RedditApiError(`Reddit rate limit reached; resets in ${Math.ceil(wait)}s`, 429, ["RATELIMIT"]);
    }
    const redirect = readRedirect(res.status, res.headers.get("location"));
    if (redirect) {
      this.users.delete(key);
      if (redirect === "signed-out") throw new RedditSessionExpiredError(c.username || undefined);
      throw new RedditApiError(`Reddit redirected the request (HTTP ${res.status}) instead of answering it, so it was not carried out`, res.status);
    }
    return res;
  }

  /** Who the session is signed in as, with a fresh modhash. Throws RedditSessionExpiredError when it isn't signed in. */
  async me(ctx: AdapterContext, c: RedditSessionCredentials, options: { fresh?: boolean } = {}): Promise<RedditSessionUser> {
    const key = this.key(c);
    const cached = this.users.get(key);
    if (!options.fresh && cached && ctx.now().getTime() - cached.at < MODHASH_TTL_MS) return cached.user;
    const res = await this.send(ctx, c, `${this.baseUrl}/api/me.json?raw_json=1`, { method: "GET" });
    const me = readMe(res.status, await res.text().catch(() => ""));
    if (me.kind === "refused") throw new RedditApiError(refusedMessage(me, "this server"), res.status);
    if (me.kind === "signed-out") {
      this.users.delete(key);
      throw new RedditSessionExpiredError(c.username || undefined);
    }
    this.users.set(key, { user: me.user, at: ctx.now().getTime() });
    return me.user;
  }

  /** Same contract as RedditClient.call: `form` POSTs (with the modhash), otherwise a GET of `<path>.json`. */
  async call<T>(
    ctx: AdapterContext,
    c: RedditSessionCredentials,
    path: string,
    opts: { form?: Record<string, string | undefined>; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    return this.serial(this.key(c), async () => {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        if (opts.form) {
          const user = await this.me(ctx, c, { fresh: attempt > 0 });
          if (user.suspended) throw new RedditApiError(`Reddit has suspended u/${user.name}: it can't post, comment or message`, 403, ["USER_SUSPENDED"]);
          const form = new URLSearchParams({ api_type: "json", uh: user.modhash });
          for (const [k, v] of Object.entries(opts.form)) if (v !== undefined) form.set(k, v);
          res = await this.send(ctx, c, `${this.baseUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Modhash": user.modhash },
            body: form.toString(),
          });
        } else {
          const url = new URL(`${this.baseUrl}${path}.json`);
          for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
          res = await this.send(ctx, c, url.toString(), { method: "GET" });
        }
        const text = await res.text().catch(() => "");
        let data: T | null = null;
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = null;
        }
        const codes = ((data as { json?: { errors?: [string][] } } | null)?.json?.errors ?? []).map((e) => String(e[0]));
        const signedOut = codes.includes("USER_REQUIRED") || res.status === 401;
        // A stale modhash, a signed-out session and a block all look alike here: ask /api/me once.
        // It throws RedditSessionExpiredError (or the block) itself; if the session is fine, retry once.
        if ((signedOut || res.status === 403 || data === null) && attempt === 0) {
          await this.me(ctx, c, { fresh: true });
          if (signedOut || (opts.form && res.status === 403)) continue;
        }
        if (signedOut) throw new RedditSessionExpiredError(c.username || undefined);
        if (!res.ok) throw httpError(res.status, data, path, res.statusText, "this server");
        if (data === null) throw pageError(path, res.status, !!opts.form, "this server");
        throwJsonErrors(data, path);
        return data;
      }
    });
  }
}
