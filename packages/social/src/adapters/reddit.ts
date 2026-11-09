import { z } from "zod";
import {
  type AdapterCapabilities,
  type AdapterContext,
  type InboundItem,
  type InboundKind,
  type PlatformAdapter,
  type PublishResult,
  type SocialAccount,
  validateAgainstCapabilities,
} from "../types";
import { type RedditCredentials as ApiCreds, RedditApiError, RedditClient, type Sleep } from "./reddit/client";
import { parseSessionCookie, RedditSessionClient, type RedditSessionCredentials, type RedditSessionUser } from "./reddit/session";

/**
 * Reddit: Dave's own account, in one of two modes.
 * - API mode: signed in on the Accounts page through a "web app" (refresh-token grant:
 *   credentials {clientId, clientSecret, refreshToken, userAgent?}, the username from the
 *   account's handle), or through a "script" app (password grant: {clientId, clientSecret,
 *   username, password, userAgent}). Calls go to Reddit's Data API.
 * - Session mode, for when Reddit won't grant an API app: credentials {sessionCookie, tokenV2?,
 *   username?, userAgent?}, the `reddit_session` cookie of Dave's own browser sign-in, used
 *   against old.reddit.com (./reddit/session.ts, with what that means and what it never does).
 *   A `sessionCookie` wins over app keys. Session accounts are paced by default (`pacing`):
 *   10 minutes between submissions and 8 a day, which the executors enforce.
 * Everything below is the same in both modes.
 *
 *
 * Publish (`POST /api/submit`) to the subreddit in `content.target` (with or without "r/"):
 * - `content.link` -> link post. If `text` is also given it is added as the author's first
 *   comment (many subreddits ask for this "submission statement" on link posts).
 * - an image in `content.media` (no link) -> link post to the image's public URL.
 *   Native image upload (the media-asset lease flow) is not implemented.
 * - otherwise -> self (text) post.
 * - `content.options`: `flairId`, `flairText`, `nsfw`, `spoiler`, `resubmit` (allow a link that was
 *   already posted there).
 * Reply (`POST /api/comment`) answers a post (t3_), comment (t1_) or private message (t4_).
 * DM: `POST /api/compose`; the subject is `options.dmSubject` or "Message from u/<username>".
 * Inbound: polls `/message/inbox` (comment replies, post replies, username mentions, messages)
 * with a fullname cursor and never marks anything read (we can't know the ingest succeeded).
 *
 * Self-promotion: the adapter enforces only hard API limits (title 300, self-text 40000,
 * comment 10000). Subreddit rules (Reddit's 1-in-10 self-promotion guideline, flair rules,
 * "no links" days, account-age/karma gates) are the drafting agent's job; when a subreddit
 * rejects a post the adapter surfaces the reason (flair required, link posts not allowed, etc).
 */

const USER_AGENT = /\(by \/?u\/[A-Za-z0-9_-]+\)/;
const USER_AGENT_HINT = "userAgent must look like '<platform>:<app id>:<version> (by /u/<username>)'";

export const RedditCredentials = z
  .object({
    /** Session mode: the `reddit_session` cookie (its value, `reddit_session=<value>`, or a pasted Cookie header). */
    sessionCookie: z.string().min(1).optional(),
    /** Session mode: the `token_v2` cookie, sent alongside when given. */
    tokenV2: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    /** Refresh-token grant (Accounts page sign-in). Without it, username + password (script app). */
    refreshToken: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    /** Required for the password grant; defaults to "web:command-centre:1.0 (by /u/<name>)" otherwise. */
    userAgent: z.string().min(1).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.userAgent && !USER_AGENT.test(c.userAgent)) ctx.addIssue({ code: "custom", path: ["userAgent"], message: USER_AGENT_HINT });
    if (c.sessionCookie) {
      try {
        parseSessionCookie(c.sessionCookie, c.tokenV2);
      } catch (err) {
        ctx.addIssue({ code: "custom", path: ["sessionCookie"], message: (err as Error).message });
      }
      return;
    }
    if (!c.clientId) ctx.addIssue({ code: "custom", path: ["clientId"], message: "clientId is required" });
    if (!c.clientSecret) ctx.addIssue({ code: "custom", path: ["clientSecret"], message: "clientSecret is required" });
    if (!c.refreshToken) {
      if (!c.username) ctx.addIssue({ code: "custom", path: ["username"], message: "username is required" });
      if (!c.password) ctx.addIssue({ code: "custom", path: ["password"], message: "password is required" });
      if (!c.userAgent) ctx.addIssue({ code: "custom", path: ["userAgent"], message: "userAgent is required" });
    }
  });

type Creds = (ApiCreds & { mode: "api" }) | RedditSessionCredentials;

/** True for an account whose credentials are a browser session cookie, not an API app. */
export const isRedditSessionAccount = (account: Pick<SocialAccount, "platform" | "credentials">) => account.platform === "reddit" && !!account.credentials.sessionCookie;

/** Default pacing of session accounts: a person's rhythm. Overridden per account in `options`. */
export const SESSION_MIN_GAP_MINUTES = 10;
export const SESSION_DAILY_CAP = 8;

export const RedditOptions = z.object({
  /** Subject for DMs sent with sendDm. */
  dmSubject: z.string().max(100).optional(),
});

export const TITLE_LIMIT = 300;
export const SELF_TEXT_LIMIT = 40_000;
export const COMMENT_LIMIT = 10_000;
const SUBREDDIT = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;
const MAX_PAGES = 5;

const capabilities: AdapterCapabilities = {
  publish: true,
  reply: true,
  dm: true,
  inbound: true,
  media: ["image"],
  maxTextLength: SELF_TEXT_LIMIT,
  requiresTitle: true,
  requiresTarget: true,
};

export interface RedditAdapterDeps {
  sleep?: Sleep;
}

/** Persisted poll cursor: the newest inbox fullname seen, and its created time (epoch s). */
interface Cursor {
  before: string | null;
  since: number;
}

interface Thing<T = Record<string, unknown>> {
  kind: string;
  data: T;
}
interface Listing<T> {
  data: { children: Thing<T>[]; after?: string | null; before?: string | null };
}
interface InboxData {
  name: string;
  id: string;
  author: string | null;
  body: string;
  created_utc: number;
  subreddit?: string | null;
  link_title?: string;
  context?: string;
  parent_id?: string | null;
  subject?: string;
  type?: string;
  was_comment?: boolean;
  dest?: string;
}
interface InfoData {
  name: string;
  body?: string;
  selftext?: string;
  title?: string;
  permalink?: string;
}

const stripSub = (s: string) => s.trim().replace(/^\/?r\//i, "");
const stripUser = (s: string) => s.trim().replace(/^\/?u(ser)?\//i, "");

type CallOptions = { form?: Record<string, string | undefined>; query?: Record<string, string | undefined> };
interface Caller {
  call<T>(ctx: AdapterContext, c: Creds, path: string, opts?: CallOptions): Promise<T>;
}

export function createRedditAdapter(deps: RedditAdapterDeps = {}): PlatformAdapter {
  const api = new RedditClient(deps.sleep);
  const session = new RedditSessionClient(deps.sleep);
  /** One call, to the Data API or to old.reddit.com with the session cookie. */
  const client: Caller = {
    call<T>(ctx: AdapterContext, c: Creds, path: string, opts: CallOptions = {}): Promise<T> {
      return c.mode === "session" ? session.call<T>(ctx, c, path, opts) : api.call<T>(ctx, c, path, opts);
    },
  };
  const creds = (account: SocialAccount): Creds => {
    const parsed = RedditCredentials.safeParse(account.credentials);
    if (!parsed.success) {
      // zod messages only name the field, never echo the value.
      throw new Error(`Reddit credentials for ${account.id} are invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    const c = parsed.data;
    // Signed in with Connect: the name comes from the account's handle ("u/name").
    const username = c.username ?? stripUser((account.handle ?? "").replace(/^@/, ""));
    const userAgent = c.userAgent ?? `web:command-centre:1.0 (by /u/${username || "command-centre"})`;
    if (c.sessionCookie) return { mode: "session", ...parseSessionCookie(c.sessionCookie, c.tokenV2), username, userAgent };
    return { mode: "api", clientId: c.clientId!, clientSecret: c.clientSecret!, username, password: c.password, refreshToken: c.refreshToken, userAgent };
  };
  /** The account's own name: from its credentials or handle, else (session mode) from Reddit. */
  const self = async (ctx: AdapterContext, c: Creds): Promise<string> => c.username || (c.mode === "session" ? (await session.me(ctx, c)).name : "");

  const comment = async (ctx: AdapterContext, c: Creds, thingId: string, text: string): Promise<PublishResult> => {
    const res = await client.call<{ json: { data?: { things?: Thing<{ id: string; name: string; permalink?: string }>[] } } }>(
      ctx,
      c,
      "/api/comment",
      { form: { thing_id: thingId, text } },
    );
    const thing = res.json.data?.things?.[0]?.data;
    if (!thing) throw new RedditApiError("Reddit accepted the comment but returned no id", 200);
    // old.reddit.com's form endpoint may give the fullname as `id` and no `name`.
    const id = thing.name ?? (/^t\d_/.test(thing.id) ? thing.id : `t1_${thing.id}`);
    return { id, url: thing.permalink ? `https://www.reddit.com${thing.permalink}` : undefined };
  };

  return {
    platform: "reddit",
    capabilities,
    credentials: RedditCredentials,

    validate(_account, content) {
      let problems = validateAgainstCapabilities(capabilities, content);
      if (content.link) problems = problems.filter((p) => p !== "text or media is required");
      if (content.title && [...content.title].length > TITLE_LIMIT) problems.push(`title is longer than ${TITLE_LIMIT} characters`);
      if (content.target?.trim() && !SUBREDDIT.test(stripSub(content.target))) problems.push(`"${content.target}" is not a valid subreddit name`);
      const images = content.media?.filter((m) => m.type === "image") ?? [];
      if (images.length > 1) problems.push("only one image per post (it is posted as a link to the image)");
      if (images.length && content.link) problems.push("a Reddit post is either a link or an image, not both");
      if (content.link && content.text && [...content.text].length > COMMENT_LIMIT) {
        problems.push(`text on a link post goes in a comment, which is limited to ${COMMENT_LIMIT} characters`);
      }
      return problems;
    },

    async publish(account, content, ctx) {
      const c = creds(account);
      const sr = stripSub(content.target ?? "");
      const title = content.title?.trim() ?? "";
      if (!sr) throw new Error("Reddit publish needs content.target (the subreddit name)");
      if (!title) throw new Error("Reddit publish needs a title");
      if ([...title].length > TITLE_LIMIT) throw new Error(`Reddit titles are limited to ${TITLE_LIMIT} characters`);
      const image = content.media?.find((m) => m.type === "image");
      const link = content.link ?? image?.url;
      const text = content.text ?? "";
      if (!link && [...text].length > SELF_TEXT_LIMIT) throw new Error(`Reddit self-text is limited to ${SELF_TEXT_LIMIT} characters`);
      const o = content.options ?? {};
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      const bool = (v: unknown) => (v === true ? "true" : undefined);

      const res = await client.call<{ json: { data?: { id?: string; name?: string; url?: string } } }>(ctx, c, "/api/submit", {
        form: {
          sr,
          title,
          kind: link ? "link" : "self",
          ...(link ? { url: link } : { text }),
          flair_id: str(o.flairId),
          flair_text: str(o.flairText),
          nsfw: bool(o.nsfw),
          spoiler: bool(o.spoiler),
          resubmit: bool(o.resubmit),
          sendreplies: "true",
        },
      });
      const data = res.json.data ?? {};
      const id = data.name ?? (data.id ? `t3_${data.id}` : undefined);
      if (!id) throw new RedditApiError("Reddit accepted the post but returned no id", 200);
      const shortId = id.replace(/^t3_/, "");
      const url = data.url?.includes("/comments/") ? data.url.replace(/^https?:\/\/old\.reddit\.com/, "https://www.reddit.com") : `https://www.reddit.com/r/${sr}/comments/${shortId}/`;

      if (link && text.trim()) {
        try {
          await comment(ctx, c, id, text);
        } catch (err) {
          ctx.log.error(`[reddit] posted ${url} but adding the text as a comment failed`, err);
        }
      }
      return { id, url };
    },

    async reply(account, target, text, ctx) {
      if (!text.trim()) throw new Error("Reddit reply text is empty");
      if ([...text].length > COMMENT_LIMIT) throw new Error(`Reddit comments are limited to ${COMMENT_LIMIT} characters`);
      if (!/^t[134]_[a-z0-9]+$/i.test(target.id)) throw new Error(`Reddit reply target "${target.id}" is not a t1_/t3_/t4_ fullname`);
      return comment(ctx, creds(account), target.id, text);
    },

    async sendDm(account, userId, text, ctx) {
      const c = creds(account);
      if (!text.trim()) throw new Error("Reddit message text is empty");
      if ([...text].length > COMMENT_LIMIT) throw new Error(`Reddit messages are limited to ${COMMENT_LIMIT} characters`);
      const opts = RedditOptions.safeParse(account.options ?? {});
      const subject = (opts.success && opts.data.dmSubject) || `Message from u/${await self(ctx, c)}`;
      const to = stripUser(userId);
      await client.call(ctx, c, "/api/compose", { form: { to, subject, text } });
      // /api/compose returns no id; look it up in the sent box (best effort).
      try {
        const sent = await client.call<Listing<InboxData>>(ctx, c, "/message/sent", { query: { limit: "1", raw_json: "1" } });
        const m = sent.data.children[0]?.data;
        if (m && m.dest?.toLowerCase() === to.toLowerCase()) return { id: m.name, url: `https://www.reddit.com/message/messages/${m.id}` };
      } catch (err) {
        ctx.log.error("[reddit] sent a message but couldn't look up its id", err);
      }
      return { id: `compose:${to}:${ctx.now().getTime()}` };
    },

    pacing(account) {
      return isRedditSessionAccount(account) ? { minGapMinutes: SESSION_MIN_GAP_MINUTES, dailyCap: SESSION_DAILY_CAP } : null;
    },

    inbound: {
      // Each poll is 1-3 requests; Reddit allows about 100 per minute per client id.
      pollIntervalSeconds: 90,

      async poll(account, cursor, ctx) {
        const c = creds(account);
        const inbox = (query: Record<string, string | undefined>) =>
          client
            .call<Listing<InboxData>>(ctx, c, "/message/inbox", { query: { raw_json: "1", mark: "false", ...query } })
            .then((l) => l.data.children);
        const nowSec = Math.floor(ctx.now().getTime() / 1000);

        if (cursor === null) {
          const newest = (await inbox({ limit: "1" }))[0]?.data;
          return { items: [], cursor: encodeCursor({ before: newest?.name ?? null, since: Math.max(nowSec, newest?.created_utc ?? 0) }) };
        }

        const state = decodeCursor(cursor);
        let things: Thing<InboxData>[] = [];
        if (state.before) {
          let before = state.before;
          for (let page = 0; page < MAX_PAGES; page++) {
            const children = await inbox({ before, limit: "100" });
            things.push(...children);
            if (children.length < 100 || !children[0]) break;
            before = children[0].data.name;
          }
        }
        if (!things.length) {
          // Nothing newer than the cursor. If the cursor item vanished from the inbox, `before`
          // returns nothing forever, so check the newest item and fall back to timestamps.
          const newest = await inbox({ limit: state.before ? "1" : "100" });
          const head = newest[0]?.data;
          if (head && head.name !== state.before && head.created_utc >= state.since) {
            things = state.before ? await inbox({ limit: "100" }) : newest;
            things = things.filter((t) => t.data.created_utc >= state.since && t.data.name !== state.before);
            if (state.before) ctx.log.info(`[reddit] ${account.id}: inbox cursor ${state.before} no longer listed, resynced by time`);
          }
        }

        const seen = new Set<string>();
        const fresh = things
          .map((t) => t.data)
          .filter((d) => d?.name && !seen.has(d.name) && seen.add(d.name))
          .sort((a, b) => a.created_utc - b.created_utc);
        if (!fresh.length) return { items: [], cursor };

        const parents = await fetchParents(ctx, c, fresh, client);
        const own = (await self(ctx, c)).toLowerCase();
        const items = fresh
          .filter((d) => (d.author ?? "").toLowerCase() !== own)
          .map((d) => toInboundItem(d, parents));
        const newest = fresh[fresh.length - 1]!;
        return { items, cursor: encodeCursor({ before: newest.name, since: Math.max(state.since, newest.created_utc) }) };
      },
    },
  };
}

function encodeCursor(c: Cursor): string {
  return JSON.stringify(c);
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    return { before: typeof c.before === "string" ? c.before : null, since: typeof c.since === "number" ? c.since : 0 };
  } catch {
    return { before: raw || null, since: 0 };
  }
}

/** Parent comments/posts of the inbox comments, in one /api/info call. */
async function fetchParents(ctx: AdapterContext, c: Creds, items: InboxData[], client: Caller): Promise<Map<string, InfoData>> {
  const ids = [...new Set(items.filter((d) => d.was_comment !== false && d.parent_id).map((d) => d.parent_id!))].slice(0, 100);
  const out = new Map<string, InfoData>();
  if (!ids.length) return out;
  try {
    const res = await client.call<Listing<InfoData>>(ctx, c, "/api/info", { query: { id: ids.join(","), raw_json: "1" } });
    for (const t of res.data.children) out.set(t.data.name, t.data);
  } catch (err) {
    ctx.log.error("[reddit] couldn't load parent comments/posts; items go without that context", err);
  }
  return out;
}

const KIND: Record<string, InboundKind> = {
  comment_reply: "reply",
  post_reply: "comment",
  username_mention: "mention",
};

function toInboundItem(d: InboxData, parents: Map<string, InfoData>): InboundItem {
  const isMessage = d.name.startsWith("t4_") || d.was_comment === false;
  const kind: InboundKind = isMessage ? "dm" : KIND[d.type ?? ""] ?? "comment";
  const author = d.author ?? (d.subreddit ? `r/${d.subreddit}` : "reddit");
  const postMatch = d.context?.match(/\/comments\/([a-z0-9]+)\//i);
  const postId = postMatch ? `t3_${postMatch[1]}` : undefined;
  const parent = d.parent_id ? parents.get(d.parent_id) : undefined;
  const url = isMessage
    ? `https://www.reddit.com/message/messages/${d.id}`
    : d.context
      ? `https://www.reddit.com${d.context.replace(/\?.*$/, "")}`
      : undefined;
  const postUrl = postMatch && d.subreddit ? `https://www.reddit.com/r/${d.subreddit}/comments/${postMatch[1]}/` : undefined;
  const parentText = parent ? (parent.name.startsWith("t3_") ? parent.selftext : parent.body) : undefined;

  return {
    id: d.name,
    kind,
    author: d.author ? { id: d.author, name: d.author, handle: `u/${d.author}`, url: `https://www.reddit.com/user/${d.author}` } : { id: author, name: author },
    text: d.body ?? "",
    ...(url ? { url } : {}),
    createdAt: new Date(d.created_utc * 1000).toISOString(),
    replyTarget: { platform: "reddit", kind, id: d.name, ...(d.subreddit ? { subreddit: d.subreddit } : {}) },
    context: {
      ...(d.subreddit ? { subreddit: d.subreddit } : {}),
      ...(postId ? { postId } : {}),
      ...(postUrl ? { postUrl } : {}),
      ...(isMessage ? (d.subject ? { postText: `Subject: ${d.subject}` } : {}) : d.link_title ? { postText: d.link_title } : {}),
      ...(parentText ? { parentText } : {}),
    },
  };
}

/**
 * Who a session cookie signs in as (the Accounts page's "Test"): the username and karma, from
 * old.reddit.com's /api/me.json. Throws RedditSessionExpiredError when it doesn't sign in.
 */
export async function redditSessionWhoami(credentials: { sessionCookie: string; tokenV2?: string; userAgent?: string }, ctx: AdapterContext, baseUrl?: string): Promise<RedditSessionUser> {
  const c: RedditSessionCredentials = { mode: "session", ...parseSessionCookie(credentials.sessionCookie, credentials.tokenV2), username: "", userAgent: credentials.userAgent ?? "web:command-centre:1.0 (by /u/command-centre)" };
  return new RedditSessionClient(undefined, baseUrl).me(ctx, c, { fresh: true });
}

export { RedditApiError } from "./reddit/client";
export { parseSessionCookie, REDDIT_OLD, RedditSessionExpiredError, sessionCookieHeader } from "./reddit/session";
export const redditAdapter: PlatformAdapter = createRedditAdapter();

