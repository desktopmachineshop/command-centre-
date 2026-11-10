import { htmlToText } from "../html";
import { type AtomEntry, type RedditReader, RedditReadError } from "./client";

/**
 * Reddit listings, threads, subreddit rules and user histories as compact data for an agent:
 * fullnames (t3_ for a post, t1_ for a comment) that `social.reply` takes as a target, ISO times,
 * and text cut to a stated length. `partial: true` marks an answer that came from the RSS feed,
 * which has no scores, comment counts or flags.
 */

export interface RedditPost {
  /** Fullname, e.g. "t3_1abcde": the id a reply targets. */
  id: string;
  subreddit: string | null;
  title: string;
  author: string | null;
  url: string;
  created: string | null;
  ageHours: number | null;
  text: string;
  score?: number;
  comments?: number;
  /** The link of a link post. */
  link?: string;
  flair?: string;
  locked?: boolean;
  archived?: boolean;
  stickied?: boolean;
  nsfw?: boolean;
  removed?: boolean;
}

export interface RedditComment {
  /** Fullname, e.g. "t1_kxyz12". */
  id: string;
  author: string | null;
  /** 0 for a top-level comment. */
  depth: number;
  created: string | null;
  text: string;
  score?: number;
  /** Written by the thread's author. */
  op?: boolean;
  /** A moderator speaking as one, or a pinned comment (often the rules). */
  mod?: boolean;
  parent?: string;
}

interface Thing<T = Record<string, unknown>> {
  kind: string;
  data: T;
}
interface Listing {
  data?: { children?: Thing[]; after?: string | null };
}

const SUB = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;
const USER = /^[A-Za-z0-9_-]{3,20}$/;

export const cleanSubreddit = (s: string): string => {
  const name = s.trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?r\//i, "").replace(/\/.*$/, "");
  if (!SUB.test(name)) throw new RedditReadError(`"${s}" is not a subreddit name`);
  return name;
};

export const cleanUser = (s: string): string => {
  const name = s.trim().replace(/^@/, "").replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?u(ser)?\//i, "").replace(/\/.*$/, "");
  if (!USER.test(name)) throw new RedditReadError(`"${s}" is not a Reddit username`);
  return name;
};

/** A thread's short id (and a comment's, from a comment permalink) from an id, fullname or URL. */
export function threadRef(ref: string): { id: string; comment?: string } {
  const s = ref.trim();
  const url = /\/comments\/([a-z0-9]+)(?:\/[^/?#]*\/([a-z0-9]+))?/i.exec(s);
  if (url) return { id: url[1]!.toLowerCase(), ...(url[2] ? { comment: url[2].toLowerCase() } : {}) };
  const id = /^(?:t3_)?([a-z0-9]{4,10})$/i.exec(s)?.[1];
  if (!id) throw new RedditReadError(`"${ref.slice(0, 120)}" is not a Reddit thread: give its id (t3_…) or its URL`);
  return { id: id.toLowerCase() };
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const iso = (sec: unknown) => (typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function age(created: string | null, now: Date): number | null {
  if (!created) return null;
  const t = Date.parse(created);
  return Number.isFinite(t) ? Math.max(0, Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10) : null;
}

export function toPost(d: Record<string, unknown>, now: Date, textChars: number): RedditPost {
  const created = iso(d.created_utc);
  const selftext = str(d.selftext) ?? "";
  const post: RedditPost = {
    id: str(d.name) ?? `t3_${String(d.id ?? "")}`,
    subreddit: str(d.subreddit) ?? null,
    title: str(d.title) ?? "",
    author: str(d.author) ?? null,
    url: d.permalink ? `https://www.reddit.com${String(d.permalink)}` : (str(d.url) ?? ""),
    created,
    ageHours: age(created, now),
    text: clip(selftext, textChars),
  };
  if (typeof d.score === "number") post.score = d.score;
  if (typeof d.num_comments === "number") post.comments = d.num_comments;
  if (d.is_self === false && str(d.url)) post.link = str(d.url);
  const flair = str(d.link_flair_text);
  if (flair) post.flair = flair;
  if (d.locked === true) post.locked = true;
  if (d.archived === true) post.archived = true;
  if (d.stickied === true) post.stickied = true;
  if (d.over_18 === true) post.nsfw = true;
  if (d.removed_by_category || selftext === "[removed]") post.removed = true;
  return post;
}

function postFromAtom(e: AtomEntry, now: Date, textChars: number): RedditPost {
  const created = e.updated ? new Date(e.updated).toISOString() : null;
  // Reddit's feed content ends "submitted by /u/x [link] [comments]": the text before it is the post's.
  const text = htmlToText(e.html).replace(/\s*submitted by\s+\/u\/[\s\S]*$/i, "").trim();
  return { id: e.id, subreddit: e.subreddit, title: e.title, author: e.author, url: e.link ?? "", created, ageHours: age(created, now), text: clip(text, textChars) };
}

const posts = (listing: Listing, now: Date, textChars: number) => (listing.data?.children ?? []).filter((c) => c.kind === "t3").map((c) => toPost(c.data, now, textChars));

export interface ListOptions {
  limit?: number;
  /** Only posts newer than this. */
  maxAgeHours?: number;
  textChars?: number;
  now?: Date;
}

function finish(rows: RedditPost[], o: ListOptions, partial: boolean) {
  const kept = o.maxAgeHours === undefined ? rows : rows.filter((p) => p.ageHours === null || p.ageHours <= o.maxAgeHours!);
  return { posts: kept.slice(0, o.limit ?? 25), ...(partial ? { partial: true as const } : {}) };
}

export type Sort = "new" | "hot" | "top" | "rising";
export type Time = "hour" | "day" | "week" | "month" | "year" | "all";

export async function subredditPosts(reader: RedditReader, subreddit: string, sort: Sort = "new", time?: Time, o: ListOptions = {}) {
  const sub = cleanSubreddit(subreddit);
  const now = o.now ?? new Date();
  const textChars = o.textChars ?? 500;
  const query = { limit: Math.min(o.limit ?? 25, 100), ...(sort === "top" ? { t: time ?? "week" } : {}) };
  const result = await reader.get<{ rows: RedditPost[]; partial: boolean } | Listing>(`/r/${sub}/${sort}`, query, (entries) => ({ rows: entries.filter((e) => e.id.startsWith("t3_")).map((e) => postFromAtom(e, now, textChars)), partial: true }));
  const rows = "rows" in result ? result.rows : posts(result, now, textChars);
  return { subreddit: sub, sort, ...finish(rows, o, "rows" in result && result.partial) };
}

export async function searchPosts(reader: RedditReader, q: string, options: ListOptions & { subreddit?: string; sort?: "relevance" | "new" | "top" | "comments"; time?: Time } = {}) {
  const now = options.now ?? new Date();
  const textChars = options.textChars ?? 500;
  const sub = options.subreddit ? cleanSubreddit(options.subreddit) : null;
  const query = { q, sort: options.sort ?? "new", t: options.time ?? "week", limit: Math.min(options.limit ?? 25, 100), type: "link", ...(sub ? { restrict_sr: 1 } : {}) };
  const result = await reader.get<{ rows: RedditPost[]; partial: boolean } | Listing>(sub ? `/r/${sub}/search` : "/search", query, (entries) => ({
    rows: entries.filter((e) => e.id.startsWith("t3_")).map((e) => postFromAtom(e, now, textChars)),
    partial: true,
  }));
  const rows = "rows" in result ? result.rows : posts(result, now, textChars);
  return { query: q, subreddit: sub, ...finish(rows, options, "rows" in result && result.partial) };
}

export interface ThreadOptions {
  /** Reply levels read (1 = top-level comments only). Default 3. */
  depth?: number;
  /** Most comments returned. Default 40. */
  limit?: number;
  sort?: "confidence" | "top" | "new" | "old" | "qa" | "controversial";
  textChars?: number;
  now?: Date;
}

export async function thread(reader: RedditReader, ref: string, o: ThreadOptions = {}) {
  const { id, comment } = threadRef(ref);
  const now = o.now ?? new Date();
  const depth = Math.min(Math.max(o.depth ?? 3, 1), 8);
  const limit = Math.min(Math.max(o.limit ?? 40, 1), 150);
  const textChars = o.textChars ?? 1200;
  const query = { limit: Math.min(limit * 2, 200), depth, sort: o.sort ?? "confidence", ...(comment ? { comment, context: 3 } : {}) };
  type Flat = { post: RedditPost; comments: RedditComment[]; hidden: number; partial: boolean };
  const result = await reader.get<Flat | unknown[]>(`/comments/${id}`, query, (entries): Flat => {
    const [first, ...rest] = entries;
    if (!first) throw new RedditReadError("Reddit has nothing there (check the thread id)", 404);
    return {
      post: postFromAtom(first, now, 6000),
      comments: rest.slice(0, limit).map((e) => ({ id: e.id, author: e.author, depth: 0, created: e.updated ? new Date(e.updated).toISOString() : null, text: clip(htmlToText(e.html), textChars) })),
      hidden: Math.max(0, rest.length - limit),
      partial: true,
    };
  });
  if (!Array.isArray(result)) return { ...result, ...(result.partial ? { note: "From Reddit's feed: comments are flat (no reply nesting) and have no scores" } : {}) };

  const [postListing, commentListing] = result as Listing[];
  const postData = postListing?.data?.children?.[0]?.data;
  if (!postData) throw new RedditReadError("Reddit has nothing there (check the thread id)", 404);
  const post = toPost(postData, now, 6000);
  const comments: RedditComment[] = [];
  let hidden = 0;
  const walk = (children: Thing[] | undefined, level: number) => {
    for (const c of children ?? []) {
      if (c.kind === "more") {
        hidden += typeof c.data.count === "number" ? c.data.count : 0;
        continue;
      }
      if (c.kind !== "t1") continue;
      const d = c.data;
      const replies = (d.replies as Listing | "" | undefined) || undefined;
      if (comments.length >= limit || level >= depth) {
        hidden += 1;
        continue;
      }
      const row: RedditComment = { id: str(d.name) ?? `t1_${String(d.id)}`, author: str(d.author) ?? null, depth: level, created: iso(d.created_utc), text: clip(str(d.body) ?? "", textChars) };
      if (typeof d.score === "number") row.score = d.score;
      if (d.is_submitter === true) row.op = true;
      if (d.distinguished === "moderator" || d.stickied === true) row.mod = true;
      if (level > 0 && str(d.parent_id)) row.parent = str(d.parent_id);
      comments.push(row);
      walk(replies?.data?.children, level + 1);
    }
  };
  walk(commentListing?.data?.children, 0);
  return { post, comments, hidden, partial: false };
}

export async function subredditInfo(reader: RedditReader, subreddit: string, textChars = 3000) {
  const sub = cleanSubreddit(subreddit);
  const about = await reader.get<Thing>(`/r/${sub}/about`);
  const d = about.data ?? {};
  // Rules are a second request; a subreddit that hides them still has its sidebar.
  let rules: { name: string; description: string; appliesTo: string }[] = [];
  let rulesError: string | undefined;
  try {
    const res = await reader.get<{ rules?: Record<string, unknown>[] }>(`/r/${sub}/about/rules`);
    rules = (res.rules ?? []).map((r) => ({ name: str(r.short_name) ?? "", description: clip(str(r.description) ?? "", 800), appliesTo: r.kind === "link" ? "posts" : r.kind === "comment" ? "comments" : "posts and comments" }));
  } catch (err) {
    rulesError = (err as Error).message;
  }
  return {
    subreddit: str(d.display_name) ?? sub,
    title: str(d.title) ?? null,
    about: clip(str(d.public_description) ?? "", 600),
    subscribers: typeof d.subscribers === "number" ? d.subscribers : null,
    type: str(d.subreddit_type) ?? null,
    /** "any", "link" (no text posts) or "self" (no link posts). */
    postsAllowed: str(d.submission_type) ?? null,
    nsfw: d.over18 === true,
    created: iso(d.created_utc),
    rules,
    ...(rulesError ? { rulesError } : {}),
    /** The sidebar often holds the self-promotion rules and the weekly thread schedule. */
    sidebar: clip(str(d.description) ?? "", textChars),
    submitText: clip(str(d.submit_text) ?? "", 1200),
  };
}

export interface HistoryItem {
  id: string;
  kind: "post" | "comment";
  subreddit: string | null;
  created: string | null;
  /** A post's title, or the title of the thread a comment is on. */
  title: string;
  text: string;
  url: string;
  score?: number;
  link?: string;
  /** Mentions one of the owner's own domains or names. */
  selfPromo?: boolean;
}

/** A user's recent posts and comments, newest first, with a count of how many mention their own things. */
export async function userHistory(
  reader: RedditReader,
  username: string,
  o: { kind?: "overview" | "submitted" | "comments"; limit?: number; own?: string[]; textChars?: number; now?: Date } = {},
) {
  const user = cleanUser(username);
  const now = o.now ?? new Date();
  const limit = Math.min(o.limit ?? 50, 100);
  const textChars = o.textChars ?? 300;
  const own = (o.own ?? []).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")).filter((s) => s.length >= 3);
  const mentions = (...parts: (string | undefined)[]) => own.length > 0 && parts.some((p) => p && own.some((needle) => p.toLowerCase().includes(needle)));
  const kind = o.kind ?? "overview";
  type Rows = { rows: HistoryItem[]; partial: boolean };
  const result = await reader.get<Rows | Listing>(`/user/${user}/${kind}`, { limit, sort: "new" }, (entries): Rows => ({
    partial: true,
    rows: entries.map((e) => {
      const text = htmlToText(e.html);
      const item: HistoryItem = { id: e.id, kind: e.id.startsWith("t3_") ? "post" : "comment", subreddit: e.subreddit, created: e.updated ? new Date(e.updated).toISOString() : null, title: e.title, text: clip(text, textChars), url: e.link ?? "" };
      if (mentions(text, e.title, e.html)) item.selfPromo = true;
      return item;
    }),
  }));
  const rows: HistoryItem[] =
    "rows" in result
      ? result.rows
      : (result.data?.children ?? [])
          .filter((c) => c.kind === "t1" || c.kind === "t3")
          .map((c) => {
            const d = c.data;
            const isPost = c.kind === "t3";
            const body = (isPost ? str(d.selftext) : str(d.body)) ?? "";
            const link = isPost && d.is_self === false ? str(d.url) : undefined;
            const item: HistoryItem = {
              id: str(d.name) ?? "",
              kind: isPost ? "post" : "comment",
              subreddit: str(d.subreddit) ?? null,
              created: iso(d.created_utc),
              title: (isPost ? str(d.title) : str(d.link_title)) ?? "",
              text: clip(body, textChars),
              url: d.permalink ? `https://www.reddit.com${String(d.permalink)}` : "",
            };
            if (typeof d.score === "number") item.score = d.score;
            if (link) item.link = link;
            if (mentions(body, link, isPost ? str(d.title) : undefined)) item.selfPromo = true;
            return item;
          });
  const items = rows.slice(0, limit);
  const promo = items.filter((i) => i.selfPromo).length;
  const bySubreddit: Record<string, number> = {};
  for (const i of items) if (i.subreddit) bySubreddit[i.subreddit] = (bySubreddit[i.subreddit] ?? 0) + 1;
  const newest = items[0]?.created ?? null;
  return {
    username: user,
    items,
    summary: {
      total: items.length,
      posts: items.filter((i) => i.kind === "post").length,
      comments: items.filter((i) => i.kind === "comment").length,
      ...(own.length
        ? {
            selfPromo: promo,
            /** Share of recent activity that mentions the owner's own things; Reddit's guideline is about 1 in 10 (0.1). */
            selfPromoRatio: items.length ? Math.round((promo / items.length) * 100) / 100 : 0,
            checkedFor: own,
          }
        : {}),
      bySubreddit,
      lastActivity: newest,
      hoursSinceLast: age(newest, now),
    },
    ...("rows" in result && result.partial ? { partial: true as const } : {}),
  };
}
