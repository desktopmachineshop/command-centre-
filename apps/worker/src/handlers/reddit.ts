import { setTimeout as sleep } from "node:timers/promises";
import {
  readMe,
  readRedirect,
  REDDIT_BROWSER_JOB,
  REDDIT_BROWSER_PATHS,
  RedditBrowserPayload,
  type RedditBrowserResult,
  type OldRedditMe,
  refusedMessage,
} from "@cc/core";
import type { APIResponse, BrowserContext } from "playwright-core";
import { findPlaywrightDir, loadPlaywrightFrom } from "../browser";
import { defineHandler } from "./registry";

/**
 * `social.reddit.browser`: posts, replies and messages to Reddit from this PC's Chrome (or Edge),
 * for when Reddit refuses Dave's session from the server (docs/plans/reddit-browser-worker.md).
 *
 * - The browser is the one installed on the PC, driven by playwright-core (the same discovery as
 *   screen capture, ../browser.ts), in a **visible** window with a **profile of its own**
 *   (`<worker data dir>/reddit-profile`): never Dave's everyday profile, so nothing else he is
 *   signed in to is touched, and Chrome doesn't complain about a profile in use.
 * - Dave signs in to Reddit in that window himself (`op: "login"`, from the Devices page or
 *   `cc-worker reddit-login`). The worker never sees or stores his password; the profile keeps
 *   Reddit's cookies like any browser would.
 * - Each action is one request from inside that browser session (`context.request`: its cookies,
 *   this PC's address) to old.reddit.com's own form endpoint, with the modhash from
 *   /api/me.json, exactly as session mode sends it from the server. Only the fixed paths in
 *   @cc/core REDDIT_BROWSER_PATHS can be called. Reddit's JSON goes back to the server, which
 *   reads it as session mode does.
 * - Nothing here hides that it is automated: no stealth plugins, no patched navigator.webdriver,
 *   no User-Agent of its own (Chrome's own is sent), no proxies, no captcha solving. When Reddit
 *   blocks or challenges, the job fails with what Reddit said; Dave can deal with it in the window.
 * - One job at a time, in one window. The window stays open between jobs (so a reply doesn't
 *   flash a new window up each time) and closes after `idleCloseMs` without a job; if Dave closes
 *   it, the next job opens it again.
 */

type Playwright = typeof import("playwright-core");

export const REDDIT_OLD_URL = "https://old.reddit.com";
const IDLE_CLOSE_MS = 15 * 60_000;
const LOGIN_POLL_MS = 2_000;

export interface RedditBrowserOptions {
  /** Chrome, Edge or Chromium (../browser.ts findBrowser). */
  chromiumBin: string | null | undefined;
  /** The dedicated profile folder: `<worker data dir>/reddit-profile`. */
  profileDir: string;
  /** Test only: a local fake of old.reddit.com. */
  baseUrl?: string;
  /** Test only (CI has no display). On Dave's PC the window is always visible. */
  headless?: boolean;
  idleCloseMs?: number;
  loginPollMs?: number;
  load?: () => Promise<Playwright>;
  log?: (line: string) => void;
}

type Failure = Extract<RedditBrowserResult, { ok: false }>;
const fail = (code: Failure["code"], message: string, extra: { status?: number; retryAfterSec?: number } = {}): Failure => ({ ok: false, code, message, ...extra });

const publicUser = (u: OldRedditMe) => ({ name: u.name, linkKarma: u.linkKarma, commentKarma: u.commentKarma, suspended: u.suspended });

/** playwright-core: the copy beside the desktop app, else the package (development). */
async function defaultLoad(): Promise<Playwright> {
  const dir = findPlaywrightDir();
  return dir ? loadPlaywrightFrom(dir)() : import("playwright-core");
}

/** A short, plain description of a page Reddit sent instead of data (its title). */
function pageSummary(text: string): string {
  const title = /<title[^>]*>([^<]{1,120})/i.exec(text)?.[1]?.trim();
  return title ? `"${title}"` : "a page";
}

export class RedditBrowser {
  private context: BrowserContext | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | undefined;
  private readonly base: string;

  constructor(private readonly options: RedditBrowserOptions) {
    this.base = (options.baseUrl ?? REDDIT_OLD_URL).replace(/\/+$/, "");
  }

  /** One job at a time: one window, one request after another, as a person would. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** The profile's window, opened if it isn't. */
  private async open(): Promise<BrowserContext> {
    clearTimeout(this.idle);
    if (this.context) return this.context;
    if (!this.options.chromiumBin) throw new BrowserProblem("No Chrome or Edge was found on this PC, so it can't post to Reddit (install Chrome, or set chromiumBin in worker.json)");
    let pw: Playwright;
    try {
      pw = await (this.options.load ?? defaultLoad)();
    } catch (err) {
      throw new BrowserProblem(`playwright-core couldn't be loaded on this PC: ${(err as Error).message}`);
    }
    try {
      const context = await pw.chromium.launchPersistentContext(this.options.profileDir, { executablePath: this.options.chromiumBin, headless: this.options.headless ?? false });
      context.on("close", () => {
        if (this.context === context) this.context = null;
      });
      this.context = context;
      this.options.log?.(`[reddit] opened the Reddit window (profile ${this.options.profileDir})`);
      return context;
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0] ?? "";
      throw new BrowserProblem(`Chrome couldn't open the Reddit profile (${msg}). If a Reddit window from Command Centre is already open in another program (cc-worker reddit-login), close it and try again.`);
    }
  }

  /** Closes the window after a quiet spell. */
  private rest(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), this.options.idleCloseMs ?? IDLE_CLOSE_MS);
    this.idle.unref?.();
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => {});
  }

  /** Runs one job's op. Problems Reddit or the browser report come back as `{ ok: false, code }`. */
  run(raw: unknown, signal?: AbortSignal): Promise<RedditBrowserResult> {
    const payload = RedditBrowserPayload.parse(raw);
    return this.serial(async () => {
      try {
        const context = await this.open();
        return await this.op(context, payload, signal);
      } catch (err) {
        if (err instanceof BrowserProblem) return fail("BROWSER", err.message);
        // The window was closed under the job, or Chrome went away.
        if (/closed|Target page|has been closed|disconnected/i.test((err as Error).message)) {
          this.context = null;
          return fail("BROWSER", "The Reddit window was closed while the job ran; nothing more was done. Check Reddit before sending it again.");
        }
        throw err;
      } finally {
        this.rest();
      }
    });
  }

  private async op(context: BrowserContext, payload: RedditBrowserPayload, signal?: AbortSignal): Promise<RedditBrowserResult> {
    if (payload.op === "login") return this.login(context, payload.timeoutSec * 1000, signal);
    const me = await this.me(context);
    if (!me.ok) return me;
    const user = publicUser(me.user);
    if (payload.username && me.user.name.toLowerCase() !== payload.username.toLowerCase()) {
      return { ...fail("WRONG_USER", `The PC's Reddit window is signed in as u/${me.user.name}, not u/${payload.username}. Sign in as u/${payload.username} there (Devices page, Sign in to Reddit), or change the account's handle.`), user };
    }
    if (payload.op === "whoami") return { ok: true, user, status: 200 };
    if (!("form" in payload)) {
      const res = await context.request.get(`${this.base}${REDDIT_BROWSER_PATHS[payload.op]}`, { params: payload.query, maxRedirects: 0, failOnStatusCode: false, headers: { Accept: "application/json" } });
      return this.answer(res, REDDIT_BROWSER_PATHS[payload.op], user, false);
    }
    if (me.user.suspended) return { ...fail("USER_SUSPENDED", `Reddit has suspended u/${me.user.name}: it can't post, comment or message`), user };
    return this.act(context, payload, me.user.modhash, user);
  }

  /** One POST to a form endpoint, retried once with a fresh modhash if Reddit says it's stale. */
  private async act(context: BrowserContext, payload: Extract<RedditBrowserPayload, { form: unknown }>, firstModhash: string, user: ReturnType<typeof publicUser>): Promise<RedditBrowserResult> {
    const path = REDDIT_BROWSER_PATHS[payload.op];
    let modhash = firstModhash;
    for (let attempt = 0; ; attempt++) {
      const res = await context.request.post(`${this.base}${path}`, {
        form: { api_type: "json", ...payload.form, uh: modhash },
        headers: { "X-Modhash": modhash, Accept: "application/json" },
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      const codes = await errorCodes(res);
      // A stale modhash, a signed-out session and a block look alike: ask /api/me once, then retry once.
      if (attempt === 0 && (codes.includes("USER_REQUIRED") || res.status() === 401 || res.status() === 403)) {
        const again = await this.me(context);
        if (!again.ok) return again;
        modhash = again.user.modhash;
        continue;
      }
      if (codes.includes("USER_REQUIRED") || res.status() === 401) return fail("USER_REQUIRED", "Reddit says the PC's Reddit window isn't signed in");
      return this.answer(res, path, user, true);
    }
  }

  /** Who the window is signed in as, with a fresh modhash; or why not. */
  private async me(context: BrowserContext): Promise<{ ok: true; user: OldRedditMe } | Failure> {
    const res = await context.request.get(`${this.base}/api/me.json?raw_json=1`, { maxRedirects: 0, failOnStatusCode: false, headers: { Accept: "application/json" } });
    const early = limitOrRedirect(res, "/api/me.json");
    if (early) return early;
    const me = readMe(res.status(), await res.text().catch(() => ""));
    if (me.kind === "refused") return fail("BLOCKED", refusedMessage(me, "this PC"), { status: me.status });
    if (me.kind === "signed-out") return fail("USER_REQUIRED", "The PC's Reddit window isn't signed in to Reddit");
    return { ok: true, user: me.user };
  }

  /** Reddit's answer to an action or read, as the job's result. */
  private async answer(res: APIResponse, path: string, user: ReturnType<typeof publicUser>, posting: boolean): Promise<RedditBrowserResult> {
    const early = limitOrRedirect(res, path);
    if (early) return { ...early, user };
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      const what = posting ? "check the account on Reddit before sending it again" : "nothing was read";
      return { ...fail("BLOCKED", `Reddit answered ${path} with ${pageSummary(text)} instead of data (it may be asking for a captcha or blocking this PC; look at the Reddit window); ${what}`, { status: res.status() }), user };
    }
    return { ok: true, user, status: res.status(), data };
  }

  /** Opens the login page in the window and waits for Dave to sign in there. */
  private async login(context: BrowserContext, timeoutMs: number, signal?: AbortSignal): Promise<RedditBrowserResult> {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${this.base}/login`).catch((err: Error) => this.options.log?.(`[reddit] login page: ${err.message.split("\n")[0]}`));
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const me = await this.me(context);
      if (me.ok) {
        this.options.log?.(`[reddit] signed in as u/${me.user.name}`);
        return { ok: true, user: publicUser(me.user), status: 200 };
      }
      if (me.code !== "USER_REQUIRED") return me;
      if (Date.now() >= deadline) return fail("TIMEOUT", `Nobody signed in to Reddit in the window on this PC within ${Math.round(timeoutMs / 60_000) || 1} minutes. Press Sign in to Reddit again when you're at the PC.`);
      await sleep(this.options.loginPollMs ?? LOGIN_POLL_MS, undefined, { signal }).catch(() => {});
      if (signal?.aborted) return fail("BROWSER", "The worker stopped before anyone signed in");
    }
  }
}

class BrowserProblem extends Error {}

/** A rate limit or a redirect (to the login page: signed out) instead of an answer. */
function limitOrRedirect(res: APIResponse, path: string): Failure | null {
  const headers = res.headers();
  if (res.status() === 429) {
    const wait = Number(headers["retry-after"]) || Number(headers["x-ratelimit-reset"]) || 60;
    return { ok: false, code: "RATELIMIT", message: `Reddit rate limit reached; resets in ${Math.ceil(wait)}s`, status: 429, retryAfterSec: wait };
  }
  const redirect = readRedirect(res.status(), headers.location);
  if (redirect === "signed-out") return { ok: false, code: "USER_REQUIRED", message: "Reddit sent the PC's Reddit window to its login page", status: res.status() };
  if (redirect) return { ok: false, code: "REDIRECT", message: `Reddit redirected ${path} (HTTP ${res.status()}) instead of answering it, so it was not carried out`, status: res.status() };
  return null;
}

/** Reddit's `json.errors` codes in a response, if it is JSON. */
async function errorCodes(res: APIResponse): Promise<string[]> {
  try {
    const body = JSON.parse(await res.text()) as { json?: { errors?: [string][] } };
    return (body?.json?.errors ?? []).map((e) => String(e[0]));
  } catch {
    return [];
  }
}

/** The job handler; one RedditBrowser (one window) per worker. */
export function redditBrowserHandler(options: RedditBrowserOptions | RedditBrowser) {
  const browser = options instanceof RedditBrowser ? options : new RedditBrowser(options);
  return defineHandler({
    kind: REDDIT_BROWSER_JOB,
    payload: RedditBrowserPayload,
    run: (payload, ctx) => browser.run(payload, ctx.signal),
  });
}
