import { z } from "zod";
import {
  type AdapterCapabilities,
  type AdapterContext,
  type PlatformAdapter,
  type PostContent,
  type PublishResult,
  type ReplyTarget,
  type SocialAccount,
  validateAgainstCapabilities,
} from "../types";
import { X_API_BASE, XClient, type XCredentials } from "./x/client";
import { XApiError } from "./x/errors";
import { defaultSleep, MAX_ALT_TEXT, type Sleep, uploadMedia } from "./x/media";
import { MAX_WEIGHTED_LENGTH, weightedLength } from "./x/text";

/**
 * X (Twitter) adapter: posting only, built for the free / legacy-free API access level, which can
 * create posts but can't read mentions, replies or timelines. So:
 *
 * - `inbound: false`: nothing is polled;
 * - `reply`: posts a reply with `reply.in_reply_to_tweet_id`, but only to a known post id (or a
 *   post URL Dave pasted), since inbound never produces targets;
 * - `dm: false`: DMs aren't available on the free level;
 * - auth is OAuth 1.0a user context (API key and secret plus the account's access token and secret),
 *   which never expires. OAuth 2.0 user tokens last two hours and need a rotating refresh token
 *   written back somewhere, which the static account config can't do.
 *
 * Threads: `content.options.thread` (string[]) adds follow-up posts. `content.text` (with any
 * link and media) is the first post; each thread entry replies to the one before it.
 * The result is the first post.
 */

export const X_MAX_THREAD_POSTS = 25;

const capabilities: AdapterCapabilities = {
  publish: true,
  reply: true,
  dm: false,
  inbound: false,
  media: ["image", "video"],
  maxTextLength: MAX_WEIGHTED_LENGTH,
};

const credentials = z.object({
  apiKey: z.string().min(1, "apiKey (the app's API key / consumer key) is required"),
  apiSecret: z.string().min(1, "apiSecret (the app's API key secret) is required"),
  accessToken: z.string().min(1, "accessToken (the account's OAuth 1.0a access token) is required"),
  accessTokenSecret: z.string().min(1, "accessTokenSecret (the account's OAuth 1.0a access token secret) is required"),
});

const TWEET_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]+|i\/web|i)\/status(?:es)?\/(\d{1,19})(?:[/?#].*)?$/i;

/** A post id from a numeric id or an x.com / twitter.com post URL; undefined if it's neither. */
export function parseTweetId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (/^\d{1,19}$/.test(v)) return v;
  return TWEET_URL.exec(v)?.[1];
}

function threadOf(content: PostContent): string[] | undefined {
  const t = content.options?.thread;
  return Array.isArray(t) ? (t as unknown[]).map((s) => (typeof s === "string" ? s : String(s))) : undefined;
}

/** The first post's text: X has no link field, so a link goes at the end of the text. */
function firstText(content: PostContent): string {
  const text = content.text.trim();
  if (!content.link || text.includes(content.link)) return text;
  return text ? `${text} ${content.link}` : content.link;
}

function postUrl(account: SocialAccount, id: string): string {
  const handle = account.handle?.replace(/^@/, "").trim();
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

export interface XAdapterOptions {
  /** Override for tests or a proxy. */
  baseUrl?: string;
  /** How to wait between media-processing status checks (tests pass a no-op). */
  sleep?: Sleep;
}

interface CreatePostResponse {
  data?: { id?: string; text?: string };
}

export function createXAdapter(opts: XAdapterOptions = {}): PlatformAdapter {
  const baseUrl = opts.baseUrl ?? X_API_BASE;
  const sleep = opts.sleep ?? defaultSleep;

  function clientFor(account: SocialAccount, ctx: AdapterContext): XClient {
    const parsed = credentials.safeParse(account.credentials);
    if (!parsed.success) {
      // zod messages name the missing field, never its value.
      const missing = parsed.error.issues.map((i) => String(i.path[0] ?? "credentials"));
      throw new Error(`X account "${account.id}" credentials are incomplete: ${[...new Set(missing)].join(", ")} required (apiKey, apiSecret, accessToken, accessTokenSecret)`);
    }
    return new XClient(parsed.data as XCredentials, ctx, baseUrl);
  }

  async function createPost(
    client: XClient,
    body: { text: string; media?: { media_ids: string[] }; reply?: { in_reply_to_tweet_id: string } },
    what: string,
  ): Promise<string> {
    const res = await client.request<CreatePostResponse>("POST", "/2/tweets", what, { json: body });
    const id = res.data?.id;
    if (!id) throw new XApiError(`X accepted the request to ${what} but returned no post id`, 200);
    return id;
  }

  function validate(_account: SocialAccount, content: PostContent): string[] {
    // The shared check counts code points; X counts weighted characters, so do the length here.
    const problems = validateAgainstCapabilities({ ...capabilities, maxTextLength: Number.POSITIVE_INFINITY }, {
      ...content,
      text: firstText(content),
    });
    const text = firstText(content);
    const len = weightedLength(text);
    if (len > MAX_WEIGHTED_LENGTH) {
      problems.push(`text is ${len} weighted characters; X allows ${MAX_WEIGHTED_LENGTH} (links count as 23, emoji and CJK as 2). Split it with options.thread`);
    }
    const media = content.media ?? [];
    const images = media.filter((m) => m.type === "image").length;
    const videos = media.filter((m) => m.type === "video").length;
    if (images > 4) problems.push("X allows at most 4 images per post");
    if (videos > 1) problems.push("X allows at most 1 video per post");
    if (videos && images) problems.push("X can't mix images and a video in one post");
    for (const m of media) {
      if (m.alt && m.alt.length > MAX_ALT_TEXT) problems.push(`alt text is longer than ${MAX_ALT_TEXT} characters`);
    }
    if (content.title?.trim()) problems.push("X posts have no title; put it in the text");
    if (content.target?.trim()) problems.push("X posts don't take a target");

    const raw = content.options?.thread;
    if (raw !== undefined) {
      const thread = threadOf(content)!;
      if (!Array.isArray(raw) || !raw.every((s) => typeof s === "string")) {
        problems.push("options.thread must be an array of strings");
      } else if (thread.length + 1 > X_MAX_THREAD_POSTS) {
        problems.push(`a thread can have at most ${X_MAX_THREAD_POSTS} posts`);
      } else {
        thread.forEach((t, i) => {
          if (!t.trim()) problems.push(`thread post ${i + 2} is empty`);
          const l = weightedLength(t);
          if (l > MAX_WEIGHTED_LENGTH) problems.push(`thread post ${i + 2} is ${l} weighted characters; X allows ${MAX_WEIGHTED_LENGTH}`);
        });
      }
    }
    return problems;
  }

  return {
    platform: "x",
    capabilities,
    credentials,
    validate,

    async publish(account, content, ctx): Promise<PublishResult> {
      const problems = validate(account, content);
      if (problems.length) throw new Error(`Can't post to X: ${problems.join("; ")}`);
      const client = clientFor(account, ctx);

      const mediaIds: string[] = [];
      for (const ref of content.media ?? []) mediaIds.push(await uploadMedia(client, ref, ctx, sleep));

      const text = firstText(content);
      const firstId = await createPost(
        client,
        { text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) },
        "create a post",
      );
      const first = { id: firstId, url: postUrl(account, firstId) };
      ctx.log.info(`x: posted ${first.url}`);

      const thread = threadOf(content) ?? [];
      let previous = firstId;
      for (const [i, t] of thread.entries()) {
        try {
          previous = await createPost(client, { text: t.trim(), reply: { in_reply_to_tweet_id: previous } }, `post part ${i + 2} of a thread`);
        } catch (err) {
          // Don't let a retry re-post the posts that already went out.
          const msg = err instanceof Error ? err.message : String(err);
          const partial = new XApiError(
            `Thread only partly posted (${i + 1} of ${thread.length + 1}); the first post is ${first.url}. ` +
              `Post the rest as replies to ${previous} rather than retrying the whole thread. ${msg}`,
            err instanceof XApiError ? err.status : 0,
            err instanceof XApiError ? err.resetAt : undefined,
          );
          throw partial;
        }
      }
      return first;
    },

    async reply(account, target: ReplyTarget, text, ctx): Promise<PublishResult> {
      const inReplyTo = parseTweetId(target.id) ?? parseTweetId(target.url);
      if (!inReplyTo) {
        throw new Error(
          "X replies need a known post id or an x.com post URL (e.g. https://x.com/someone/status/123…); the free tier can't look posts up",
        );
      }
      const body = text.trim();
      if (!body) throw new Error("Can't reply on X: the reply text is empty");
      const len = weightedLength(body);
      if (len > MAX_WEIGHTED_LENGTH) throw new Error(`Can't reply on X: text is ${len} weighted characters; X allows ${MAX_WEIGHTED_LENGTH}`);
      const client = clientFor(account, ctx);
      const id = await createPost(client, { text: body, reply: { in_reply_to_tweet_id: inReplyTo } }, "post a reply");
      return { id, url: postUrl(account, id) };
    },
  };
}

export const xAdapter: PlatformAdapter = createXAdapter();
