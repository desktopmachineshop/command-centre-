import { REDDIT_BROWSER_JOB, type RedditBrowserPayloadInput, RedditBrowserResult, type RedditBrowserUser } from "@cc/core";
import type { AdapterContext } from "../../types";
import { RedditApiError, throwJsonErrors } from "./client";
import { httpError, pageError } from "./session";

/**
 * Browser mode: Dave's own account, signed in by Dave himself in a Chrome window on his PC, which
 * the desktop worker drives (`social.reddit.browser` jobs, apps/worker/src/handlers/reddit.ts).
 * For when Reddit refuses the session cookie from the server's data-centre address. The adapter
 * builds exactly the forms and queries it builds in session mode; the worker sends them from
 * inside that browser's session (its cookies, its address, the modhash from /api/me.json) and
 * hands back Reddit's JSON, which is read here the same way session mode reads it.
 * It automates Dave's account outside Reddit's official API, like session mode, and the same
 * lines hold: no stealth, no proxies, no captcha solving, one account, paced.
 */

export const BROWSER_JOB_TIMEOUT_MS = 5 * 60_000;

export interface BrowserJobOptions {
  /** A worker node id, or undefined for any connected PC with a browser. */
  node?: string;
  timeoutMs: number;
  /** A post, reply or message: run at most once (never requeued if the PC drops mid-job). */
  once: boolean;
  signal?: AbortSignal;
}

/**
 * Runs a `social.reddit.browser` job on a desktop worker and waits for its result (the server
 * provides this from its job queue). Throws PcOfflineError when no suitable PC is connected or
 * none picked the job up, so nothing was done.
 */
export interface BrowserJobs {
  run(kind: typeof REDDIT_BROWSER_JOB, payload: RedditBrowserPayloadInput, options: BrowserJobOptions): Promise<unknown>;
}

/**
 * The PC that posts to Reddit isn't connected (or is busy and didn't take the job): nothing was
 * sent. `retryable`: a queued submission waits for the PC instead of failing (./pacing.ts).
 */
export class PcOfflineError extends Error {
  readonly retryable = true;
  constructor(message = "The PC that posts to Reddit isn't connected (Devices page): open the desktop app on it. Nothing was sent.") {
    super(message);
    this.name = "PcOfflineError";
  }
}

/** The PC's Reddit window isn't signed in (any more): Dave signs in again from the Devices page. */
export class RedditBrowserSignedOutError extends RedditApiError {
  /** Tells the server to raise its "sign in again" alert. */
  readonly reconnect = true;
  constructor(username?: string) {
    super(
      `Reddit isn't signed in${username ? ` as u/${username}` : ""} in the PC's Reddit window (signed out or expired). On the Devices page, press Sign in to Reddit on that PC and sign in in the window that opens.`,
      401,
      ["USER_REQUIRED"],
    );
    this.name = "RedditBrowserSignedOutError";
  }
}

export interface RedditBrowserCredentials {
  mode: "browser";
  /** The worker node to use; undefined for any PC with a browser. */
  node?: string;
  /** The account's name (without u/); empty when the account has no handle. */
  username: string;
}

/** The adapter's paths, as the worker's ops (@cc/core REDDIT_BROWSER_PATHS). */
const OPS = {
  "/api/comment": "comment",
  "/api/submit": "submit",
  "/api/compose": "compose",
  "/message/inbox": "inbox",
  "/message/sent": "sent",
  "/api/info": "info",
} as const;

const defined = (o: Record<string, string | undefined> = {}): Record<string, string> => Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined));

export class RedditBrowserClient {
  constructor(private readonly jobs?: BrowserJobs) {}

  /** Runs one job and returns Reddit's answer, or throws the error session mode would. */
  private async run(ctx: AdapterContext, c: RedditBrowserCredentials, payload: RedditBrowserPayloadInput, timeoutMs = BROWSER_JOB_TIMEOUT_MS): Promise<{ user: RedditBrowserUser; status: number; data: unknown }> {
    if (!this.jobs) throw new Error("Posting to Reddit from a PC isn't available on this server (no desktop worker queue)");
    const once = payload.op === "comment" || payload.op === "submit" || payload.op === "compose";
    const raw = await this.jobs.run(REDDIT_BROWSER_JOB, payload, { node: c.node, timeoutMs, once, signal: ctx.signal });
    const parsed = RedditBrowserResult.safeParse(raw);
    if (!parsed.success) throw new RedditApiError(`The PC sent back a Reddit result Command Centre couldn't read${once ? "; check Reddit before sending it again" : ""}`);
    const r = parsed.data;
    if (r.ok) return { user: r.user, status: r.status, data: r.data };
    switch (r.code) {
      case "USER_REQUIRED":
        throw new RedditBrowserSignedOutError(c.username || undefined);
      case "RATELIMIT":
        throw new RedditApiError(`Reddit rate limit reached${r.retryAfterSec ? `; resets in ${Math.ceil(r.retryAfterSec)}s` : ""}`, 429, ["RATELIMIT"]);
      default:
        throw new RedditApiError(r.message, r.status, [r.code]);
    }
  }

  /** Who the PC's Reddit window is signed in as (the Accounts page's Test). */
  async me(ctx: AdapterContext, c: RedditBrowserCredentials, timeoutMs?: number): Promise<RedditBrowserUser> {
    return (await this.run(ctx, c, { op: "whoami", ...(c.username ? { username: c.username } : {}) }, timeoutMs)).user;
  }

  /** Same contract as RedditSessionClient.call: `form` POSTs, otherwise a GET of `<path>.json`. */
  async call<T>(ctx: AdapterContext, c: RedditBrowserCredentials, path: string, opts: { form?: Record<string, string | undefined>; query?: Record<string, string | undefined> } = {}): Promise<T> {
    const op = OPS[path as keyof typeof OPS];
    if (!op) throw new Error(`Reddit from the PC can't call ${path}`);
    const username = c.username ? { username: c.username } : {};
    const payload: RedditBrowserPayloadInput =
      op === "comment" || op === "submit" || op === "compose" ? { op, form: defined(opts.form), ...username } : { op, query: defined(opts.query), ...username };
    const { user, status, data } = await this.run(ctx, c, payload);
    if (opts.form && user.suspended) throw new RedditApiError(`Reddit has suspended u/${user.name}: it can't post, comment or message`, 403, ["USER_SUSPENDED"]);
    if (status === 401) throw new RedditBrowserSignedOutError(c.username || undefined);
    if (status < 200 || status >= 300) throw httpError(status, data ?? null, path, "", "this PC");
    if (data === undefined || data === null) throw pageError(path, status, !!opts.form, "this PC");
    try {
      throwJsonErrors(data, path);
    } catch (err) {
      if ((err as RedditApiError).codes?.includes("USER_REQUIRED")) throw new RedditBrowserSignedOutError(c.username || undefined);
      throw err;
    }
    return data as T;
  }
}
