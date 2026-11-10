import { z } from "zod";

/**
 * `social.reddit.browser`: the last hop of a Reddit post, reply or message done from a real Chrome
 * on Dave's PC (the desktop worker, capability `browser`) instead of from the server. Shared by
 * the server's Reddit adapter (which builds the payload and reads the result the way session mode
 * reads old.reddit.com's answers) and the worker (apps/worker/src/handlers/reddit.ts), which
 * validates the payload again and only ever calls the fixed old.reddit.com paths below.
 * See docs/plans/reddit-browser-worker.md.
 */

export const REDDIT_BROWSER_JOB = "social.reddit.browser";

/**
 * What each op calls on old.reddit.com, and nothing else: the worker never takes a path from the
 * server, so a payload can't reach voting, account settings or anything not listed here.
 */
export const REDDIT_BROWSER_PATHS = {
  comment: "/api/comment",
  submit: "/api/submit",
  compose: "/api/compose",
  inbox: "/message/inbox.json",
  sent: "/message/sent.json",
  info: "/api/info.json",
} as const;
export type RedditBrowserAction = "comment" | "submit" | "compose";
export type RedditBrowserRead = "inbox" | "sent" | "info";

const Key = z.string().regex(/^[a-z][a-z_]{0,31}$/, "a Reddit form field name");
/** Form fields as the adapter builds them for /api/comment, /api/submit and /api/compose; `uh` and `api_type` are the worker's. */
const Form = z.record(Key, z.string().max(50_000)).refine((f) => !("uh" in f) && !("api_type" in f), "uh and api_type are set by the worker");
const Query = z.record(Key, z.string().max(2_000)).default({});
/** The account the job is for (without u/): the worker refuses to act when the window is signed in as someone else. */
const Username = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional();

export const RedditBrowserPayload = z.discriminatedUnion("op", [
  z.object({ op: z.literal("whoami"), username: Username }),
  /** Opens the profile's window at the login page and waits for Dave to sign in himself. */
  z.object({ op: z.literal("login"), timeoutSec: z.number().int().min(10).max(900).default(300) }),
  z.object({ op: z.enum(["comment", "submit", "compose"]), form: Form, username: Username }),
  z.object({ op: z.enum(["inbox", "sent", "info"]), query: Query, username: Username }),
]);
export type RedditBrowserPayload = z.infer<typeof RedditBrowserPayload>;
export type RedditBrowserPayloadInput = z.input<typeof RedditBrowserPayload>;

export const RedditBrowserUser = z.object({
  name: z.string(),
  linkKarma: z.number(),
  commentKarma: z.number(),
  /** Reddit marks the account suspended: it can read but not post. */
  suspended: z.boolean(),
});
export type RedditBrowserUser = z.infer<typeof RedditBrowserUser>;

/**
 * Why a job didn't get an answer from Reddit. The adapter turns these into the same errors
 * session mode throws (USER_REQUIRED means "sign in again", RATELIMIT "wait").
 */
export const RedditBrowserCode = z.enum([
  "USER_REQUIRED", // the profile isn't signed in (or the session expired)
  "WRONG_USER", // signed in, but as another account than the one the job is for
  "USER_SUSPENDED",
  "RATELIMIT",
  "BLOCKED", // Reddit refused the request or answered with a page (a block, a captcha)
  "REDIRECT",
  "BROWSER", // Chrome couldn't be started or the window was closed mid-job
  "TIMEOUT", // login: nobody signed in in time
]);
export type RedditBrowserCode = z.infer<typeof RedditBrowserCode>;

export const RedditBrowserResult = z.discriminatedUnion("ok", [
  /** Reddit answered: `data` is its JSON (which may still carry `json.errors`), `status` its HTTP status. */
  z.object({ ok: z.literal(true), user: RedditBrowserUser, status: z.number().int().default(200), data: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    code: RedditBrowserCode,
    message: z.string().max(2_000),
    status: z.number().int().optional(),
    retryAfterSec: z.number().optional(),
    user: RedditBrowserUser.optional(),
  }),
]);
export type RedditBrowserResult = z.infer<typeof RedditBrowserResult>;

// --- old.reddit.com's answers, read the same way by session mode (server) and the worker ---

export interface OldRedditMe extends RedditBrowserUser {
  /** old Reddit's CSRF token, sent as `uh` and `X-Modhash` with every POST. */
  modhash: string;
}

export type MeOutcome =
  | { kind: "user"; user: OldRedditMe }
  /** Signed out: old Reddit answers `{}` (no data, or data without a name). */
  | { kind: "signed-out" }
  /** Not JSON, or refused outright: Reddit is blocking the request, not answering "signed out". */
  | { kind: "refused"; status: number; page: boolean };

/** What `GET /api/me.json` said, from its status and body. */
export function readMe(status: number, text: string): MeOutcome {
  let body: { data?: { name?: string; modhash?: string; link_karma?: number; comment_karma?: number; is_suspended?: boolean } } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const ok = status >= 200 && status < 300;
  if (!ok || body === null || typeof body !== "object") return { kind: "refused", status, page: ok && (body === null || typeof body !== "object") };
  const d = body.data;
  if (!d?.name || !d.modhash) return { kind: "signed-out" };
  return { kind: "user", user: { name: d.name, modhash: d.modhash, linkKarma: d.link_karma ?? 0, commentKarma: d.comment_karma ?? 0, suspended: d.is_suspended === true } };
}

/** A redirect instead of an answer: to the login page when the session is signed out (seen November 2026). */
export function readRedirect(status: number, location: string | null | undefined): "signed-out" | "redirect" | null {
  if (status < 300 || status >= 400) return null;
  return /\/login\b/.test(location ?? "") ? "signed-out" : "redirect";
}

/** The message for a refused `/api/me.json`; `where` is "this server" or "this PC". */
export function refusedMessage(o: { status: number; page: boolean }, where: string): string {
  return `Reddit refused the session check (HTTP ${o.status}${o.page ? ", a page instead of data" : ""}): it may be blocking ${where} or asking for a captcha; nothing was posted.`;
}
