import { z } from "zod";
import {
  type AdapterCapabilities,
  type AdapterContext,
  type InboundItem,
  type PlatformAdapter,
  type PostContent,
  type PublishResult,
  type SocialAccount,
  validateAgainstCapabilities,
} from "../types";
import { redact, YOUTUBE_API, YOUTUBE_UPLOAD_API, YouTubeApiError, YouTubeClient, type YouTubeCredentials as Creds, withTimeout } from "./youtube/client";
import { CHUNK_UNIT, DEFAULT_CHUNK_BYTES, defaultSleep, type Sleep, uploadVideo } from "./youtube/upload";

/**
 * YouTube (Data API v3), one channel per account, OAuth 2.0 with a refresh token.
 *
 * - Publish: one video per post, uploaded with the resumable protocol (streamed from the
 *   `MediaRef` URL in chunks). `content.title` is the video title (required, 100 characters),
 *   `content.text` (+ `content.link`) the description (5000 bytes). `content.options`:
 *   `privacyStatus` ("private" by default, so nothing goes public by accident), `publishAt`
 *   (YouTube-native scheduling, needs private), `tags`, `categoryId`, `madeForKids` (false by
 *   default), `notifySubscribers`, `containsSyntheticMedia` and `thumbnailUrl` (set with
 *   `thumbnails.set` after the upload). Returns `https://youtu.be/<id>`.
 *   Shorts have no separate API: a vertical or square video up to 3 minutes becomes a Short.
 * - Reply: `comments.insert` with `parentId` (YouTube threads are one level deep; a reply to a
 *   reply goes on the thread and starts with the author's @handle).
 * - Inbound: polls `commentThreads.list?allThreadsRelatedToChannelId` (1 quota unit a page) every
 *   15 minutes by default, for new top-level comments and replies on the channel's videos. The
 *   channel's own comments are skipped.
 *
 * Quota (default per Google Cloud project): uploads have their own bucket of 100 a day; other calls
 * share 10,000 units a day (a thumbnail or a reply costs 50, a list call 1). Errors with reason
 * `quotaExceeded` say so plainly. Credentials and tokens never appear in errors or logs.
 */

export const TITLE_LIMIT = 100;
export const DESCRIPTION_BYTES = 5000;
export const TAGS_LIMIT = 500;
/** Comment replies; the executor also caps replies at `maxTextLength`. */
export const COMMENT_LIMIT = 10_000;
export const THUMBNAIL_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_POLL_SECONDS = 15 * 60;
/** Items published this long before the last poll are still looked at (YouTube can list comments late). */
const OVERLAP_MS = 15 * 60_000;
const MAX_RECENT = 1000;
const MAX_REPLY_FETCHES = 10;
const DEFAULT_POLL_PAGES = 2;

const capabilities: AdapterCapabilities = {
  publish: true,
  reply: true,
  dm: false,
  inbound: true,
  media: ["video"],
  maxTextLength: DESCRIPTION_BYTES,
  requiresMedia: true,
  requiresTitle: true,
};

export const YouTubeCredentials = z.object({
  clientId: z.string().min(1, "clientId (the OAuth client id, ...apps.googleusercontent.com) is required"),
  clientSecret: z.string().min(1, "clientSecret (the OAuth client secret) is required"),
  refreshToken: z.string().min(1, "refreshToken is required (run `pnpm --filter @cc/social youtube:auth`)"),
  channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/, "channelId must be the channel id (24 characters, starting with UC)"),
});

/** `content.options` for a YouTube post. */
export const YouTubeVideoOptions = z.object({
  privacyStatus: z.enum(["private", "unlisted", "public"]).optional(),
  publishAt: z.iso.datetime({ offset: true, error: "publishAt must be an ISO date-time, e.g. 2026-10-24T18:00:00+01:00" }).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  categoryId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
  madeForKids: z.boolean().optional(),
  notifySubscribers: z.boolean().optional(),
  containsSyntheticMedia: z.boolean().optional(),
  thumbnailUrl: z.url({ protocol: /^https?$/, error: "thumbnailUrl must be an http(s) URL" }).optional(),
  defaultLanguage: z.string().min(2).max(10).optional(),
});
export type YouTubeVideoOptions = z.infer<typeof YouTubeVideoOptions>;

/** Account `options`. */
export const YouTubeAccountOptions = z.object({
  /** Category for uploads that don't set one, e.g. "28" (Science & Technology) or "26" (Howto & Style). */
  defaultCategoryId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
  /** commentThreads pages (100 threads each, 1 quota unit each) to scan per poll. */
  pollPages: z.number().int().min(1).max(10).optional(),
});

export interface YouTubeAdapterDeps {
  /** Resumable upload chunk size; a multiple of 256 KiB. */
  chunkBytes?: number;
  sleep?: Sleep;
  /** Seconds between inbound polls (default 900, or `SOCIAL_YOUTUBE_POLL_SECONDS`). */
  pollIntervalSeconds?: number;
}

/** Bytes, as YouTube counts the description limit. */
const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** The description: the text, then the link on its own line unless the text already has it. */
export function buildDescription(content: Pick<PostContent, "text" | "link">): string {
  const text = (content.text ?? "").trim();
  if (!content.link || text.includes(content.link)) return text;
  return text ? `${text}\n\n${content.link}` : content.link;
}

/** Tags length as YouTube counts it: commas between tags count, and a tag with a space counts its quotes. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t) => n + [...t].length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

function videoOptions(content: PostContent): { options?: YouTubeVideoOptions; problems: string[] } {
  const parsed = YouTubeVideoOptions.safeParse(content.options ?? {});
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `options.${i.path.join(".") || "?"}: ${i.message}`) };
  return { options: parsed.data, problems: [] };
}

function problemsFor(content: PostContent): string[] {
  const problems = validateAgainstCapabilities(capabilities, content).filter(
    (p) => p !== `text is longer than ${DESCRIPTION_BYTES} characters`, // checked in bytes below
  );
  const videos = content.media?.filter((m) => m.type === "video") ?? [];
  if (videos.length > 1) problems.push("a YouTube post is one video");
  if (content.media?.length && !videos.length && !problems.includes("image media is not supported")) problems.push("a video is required");
  const title = content.title?.trim() ?? "";
  if ([...title].length > TITLE_LIMIT) problems.push(`title is longer than ${TITLE_LIMIT} characters`);
  if (/[<>]/.test(title)) problems.push("title can't contain < or >");
  const description = buildDescription(content);
  if (utf8Bytes(description) > DESCRIPTION_BYTES) problems.push(`description (text plus link) is longer than ${DESCRIPTION_BYTES} bytes`);
  if (/[<>]/.test(description)) problems.push("description can't contain < or >");
  if (content.target?.trim()) problems.push("YouTube doesn't use a target");
  const { options, problems: optionProblems } = videoOptions(content);
  problems.push(...optionProblems);
  if (options) {
    if (options.publishAt && (options.privacyStatus ?? "private") !== "private") {
      problems.push('options.publishAt needs privacyStatus "private" (YouTube makes it public at that time)');
    }
    if (options.tags && tagsLength(options.tags) > TAGS_LIMIT) problems.push(`tags are longer than ${TAGS_LIMIT} characters in all`);
    if (options.tags?.some((t) => /[<>,]/.test(t))) problems.push("tags can't contain <, > or commas");
  }
  return problems;
}

interface Comment {
  id: string;
  snippet?: {
    authorDisplayName?: string;
    authorProfileImageUrl?: string;
    authorChannelUrl?: string;
    authorChannelId?: { value?: string };
    channelId?: string;
    videoId?: string;
    textDisplay?: string;
    textOriginal?: string;
    parentId?: string;
    publishedAt?: string;
    updatedAt?: string;
  };
}
interface CommentThread {
  id: string;
  snippet?: { channelId?: string; videoId?: string; topLevelComment?: Comment; totalReplyCount?: number; canReply?: boolean };
  replies?: { comments?: Comment[] };
}
interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

/** Persisted poll cursor. */
interface Cursor {
  v: 1;
  /** Epoch ms of the last poll. */
  since: number;
  /** [id, published epoch ms] of items inside the overlap window, so they aren't returned twice. */
  recent: [string, number][];
  /** totalReplyCount per thread, to notice replies YouTube leaves out of the thread listing. */
  counts: Record<string, number>;
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    if (c?.v !== 1 || typeof c.since !== "number") return null;
    return {
      v: 1,
      since: c.since,
      recent: Array.isArray(c.recent)
        ? c.recent.filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "number")
        : [],
      counts: c.counts && typeof c.counts === "object" ? (c.counts as Record<string, number>) : {},
    };
  } catch {
    return null;
  }
}

const published = (c: Comment) => Date.parse(c.snippet?.publishedAt ?? "") || 0;
const watchUrl = (videoId: string, commentId?: string) =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}${commentId ? `&lc=${encodeURIComponent(commentId)}` : ""}`;
const handleOf = (name: string | undefined) => (name?.startsWith("@") ? name.slice(1) : undefined);

export function createYouTubeAdapter(deps: YouTubeAdapterDeps = {}): PlatformAdapter {
  const client = new YouTubeClient();
  const chunkBytes = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (chunkBytes <= 0 || chunkBytes % CHUNK_UNIT !== 0) throw new Error("YouTube chunkBytes must be a positive multiple of 256 KiB");
  const sleep = deps.sleep ?? defaultSleep;
  const envPoll = Number(process.env.SOCIAL_YOUTUBE_POLL_SECONDS);
  const pollIntervalSeconds = deps.pollIntervalSeconds ?? (Number.isFinite(envPoll) && envPoll >= 60 ? envPoll : DEFAULT_POLL_SECONDS);
  /** Video titles by id, so each poll looks up only new videos. */
  const titles = new Map<string, string>();

  const creds = (account: SocialAccount): Creds => {
    const parsed = YouTubeCredentials.safeParse(account.credentials);
    if (!parsed.success) {
      throw new Error(`YouTube credentials for ${account.id} are invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    return parsed.data;
  };
  const accountOptions = (account: SocialAccount) => {
    const parsed = YouTubeAccountOptions.safeParse(account.options ?? {});
    return parsed.success ? parsed.data : {};
  };

  async function setThumbnail(ctx: AdapterContext, c: Creds, videoId: string, url: string): Promise<void> {
    let img: Response;
    try {
      img = await ctx.fetch(url, { signal: withTimeout(ctx, 60_000) });
    } catch (err) {
      throw new Error(`couldn't download the thumbnail: ${(err as Error).message}`);
    }
    if (!img.ok) throw new Error(`couldn't download the thumbnail: the host answered ${img.status}`);
    const bytes = new Uint8Array(await img.arrayBuffer());
    if (bytes.byteLength > THUMBNAIL_MAX_BYTES) throw new Error("the thumbnail is larger than 50 MB");
    const header = img.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const type = header === "image/png" || /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg";
    await client.json(ctx, c, "POST", `${YOUTUBE_UPLOAD_API}/thumbnails/set`, "set the thumbnail", {
      query: { videoId, uploadType: "media" },
      body: bytes as unknown as NonNullable<RequestInit["body"]>,
      headers: { "Content-Type": type },
      timeoutMs: 120_000,
    });
  }

  async function listThreads(ctx: AdapterContext, c: Creds, pageToken?: string): Promise<ListResponse<CommentThread>> {
    return client.json<ListResponse<CommentThread>>(ctx, c, "GET", `${YOUTUBE_API}/commentThreads`, "list the channel's comments", {
      query: {
        part: "snippet,replies",
        allThreadsRelatedToChannelId: c.channelId,
        order: "time",
        maxResults: "100",
        textFormat: "plainText",
        pageToken,
      },
    });
  }

  async function listReplies(ctx: AdapterContext, c: Creds, parentId: string): Promise<Comment[]> {
    const res = await client.json<ListResponse<Comment>>(ctx, c, "GET", `${YOUTUBE_API}/comments`, "list comment replies", {
      query: { part: "snippet", parentId, maxResults: "100", textFormat: "plainText" },
    });
    return res.items ?? [];
  }

  async function videoTitles(ctx: AdapterContext, c: Creds, ids: string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !titles.has(id)).slice(0, 50);
    if (!missing.length) return;
    try {
      const res = await client.json<ListResponse<{ id: string; snippet?: { title?: string } }>>(ctx, c, "GET", `${YOUTUBE_API}/videos`, "look up video titles", {
        query: { part: "snippet", id: missing.join(","), maxResults: "50" },
      });
      for (const v of res.items ?? []) if (v.snippet?.title) titles.set(v.id, v.snippet.title);
      while (titles.size > 500) titles.delete(titles.keys().next().value!);
    } catch (err) {
      ctx.log.error("[youtube] couldn't look up video titles; items go without them", err);
    }
  }

  function toItem(comment: Comment, thread: CommentThread, kind: "comment" | "reply", parent?: Comment): InboundItem {
    const s = comment.snippet ?? {};
    const videoId = s.videoId ?? thread.snippet?.videoId;
    const name = s.authorDisplayName;
    const handle = handleOf(name);
    const authorId = s.authorChannelId?.value ?? name ?? "unknown";
    const title = videoId ? titles.get(videoId) : undefined;
    return {
      id: comment.id,
      kind,
      author: { id: authorId, ...(name ? { name } : {}), ...(handle ? { handle } : {}), ...(s.authorChannelUrl ? { url: s.authorChannelUrl } : {}) },
      text: s.textDisplay ?? s.textOriginal ?? "",
      ...(videoId ? { url: watchUrl(videoId, comment.id) } : {}),
      createdAt: new Date(published(comment) || Date.now()).toISOString(),
      replyTarget: {
        platform: "youtube",
        kind,
        id: comment.id,
        threadId: thread.id,
        ...(videoId ? { videoId } : {}),
        ...(kind === "reply" && handle ? { mention: handle } : {}),
      },
      context: {
        ...(videoId ? { postId: videoId, postUrl: `https://youtu.be/${videoId}` } : {}),
        ...(title ? { postText: title } : {}),
        ...(parent ? { parentText: parent.snippet?.textDisplay ?? parent.snippet?.textOriginal ?? "" } : {}),
      },
    };
  }

  return {
    platform: "youtube",
    capabilities,
    credentials: YouTubeCredentials,

    validate(_account, content) {
      return problemsFor(content);
    },

    async publish(account, content, ctx) {
      const c = creds(account);
      const problems = problemsFor(content);
      if (problems.length) throw new Error(`Can't upload to YouTube: ${problems.join("; ")}`);
      const media = content.media!.find((m) => m.type === "video")!;
      const options = videoOptions(content).options ?? {};
      const privacyStatus = options.privacyStatus ?? "private";
      const categoryId = options.categoryId ?? accountOptions(account).defaultCategoryId;

      const resource = {
        snippet: {
          title: content.title!.trim(),
          description: buildDescription(content),
          ...(options.tags?.length ? { tags: options.tags } : {}),
          ...(categoryId !== undefined ? { categoryId: String(categoryId) } : {}),
          ...(options.defaultLanguage ? { defaultLanguage: options.defaultLanguage } : {}),
        },
        status: {
          privacyStatus,
          ...(options.publishAt ? { publishAt: new Date(options.publishAt).toISOString() } : {}),
          selfDeclaredMadeForKids: options.madeForKids ?? false,
          ...(options.containsSyntheticMedia !== undefined ? { containsSyntheticMedia: options.containsSyntheticMedia } : {}),
        },
      };
      const video = await uploadVideo({ client, chunkBytes, sleep }, ctx, c, media, resource, {
        ...(options.notifySubscribers === false ? { notifySubscribers: "false" } : {}),
      });
      const url = `https://youtu.be/${video.id}`;

      const st = video.status;
      if (st?.uploadStatus === "rejected" || st?.uploadStatus === "failed") {
        throw new YouTubeApiError(
          `YouTube ${st.uploadStatus} the upload (${st.rejectionReason ?? st.failureReason ?? "no reason given"}): ${url}`,
          "invalid",
          200,
          st.rejectionReason ?? st.failureReason,
        );
      }
      if (privacyStatus !== "private" && st?.privacyStatus === "private") {
        ctx.log.error(
          `[youtube] ${url} was uploaded as ${privacyStatus} but YouTube made it private. Videos from unaudited API projects ` +
            "can be locked private until the project passes YouTube's API compliance audit; check YouTube Studio and docs/SETUP.md (YouTube).",
        );
      }
      if (options.thumbnailUrl) {
        try {
          await setThumbnail(ctx, c, video.id, options.thumbnailUrl);
        } catch (err) {
          // The video is up; failing the post now would invite a duplicate upload.
          ctx.log.error(
            redact(`[youtube] uploaded ${url} but setting the thumbnail failed: ${(err as Error).message}. Custom thumbnails need a verified channel; set it in YouTube Studio.`, client.secrets(c)),
          );
        }
      }
      return { id: video.id, url };
    },

    async reply(account, target, text, ctx): Promise<PublishResult> {
      const c = creds(account);
      let body = text.trim();
      if (!body) throw new Error("YouTube reply text is empty");
      const threadId = typeof target.threadId === "string" && target.threadId ? target.threadId : target.id.split(".")[0];
      if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) throw new Error(`YouTube reply target "${target.id}" is not a comment or thread id`);
      const mention = typeof target.mention === "string" && target.mention ? `@${target.mention}` : undefined;
      if (target.kind === "reply" && mention && !body.toLowerCase().startsWith(mention.toLowerCase())) body = `${mention} ${body}`;
      if ([...body].length > COMMENT_LIMIT) throw new Error(`YouTube comments are limited to ${COMMENT_LIMIT} characters`);
      const res = await client.json<Comment>(ctx, c, "POST", `${YOUTUBE_API}/comments`, "post the reply", {
        query: { part: "snippet" },
        json: { snippet: { parentId: threadId, textOriginal: body } },
      });
      if (!res.id) throw new YouTubeApiError("YouTube accepted the reply but returned no id", "server", 200);
      const videoId = res.snippet?.videoId ?? (typeof target.videoId === "string" ? target.videoId : undefined);
      return { id: res.id, ...(videoId ? { url: watchUrl(videoId, res.id) } : {}) };
    },

    inbound: {
      pollIntervalSeconds,

      async poll(account, cursor, ctx) {
        const c = creds(account);
        const now = ctx.now().getTime();
        const state = cursor === null ? null : decodeCursor(cursor);

        if (!state) {
          // First run: remember what's there now, return no backlog.
          const page = await listThreads(ctx, c);
          const counts: Record<string, number> = {};
          const recent: [string, number][] = [];
          for (const t of page.items ?? []) {
            counts[t.id] = t.snippet?.totalReplyCount ?? 0;
            for (const cm of [t.snippet?.topLevelComment, ...(t.replies?.comments ?? [])]) {
              if (cm && published(cm) > now - OVERLAP_MS) recent.push([cm.id, published(cm)]);
            }
          }
          if (cursor !== null) ctx.log.info(`[youtube] ${account.id}: unreadable cursor, starting again from now`);
          return { items: [], cursor: JSON.stringify({ v: 1, since: now, recent, counts } satisfies Cursor) };
        }

        const pages = accountOptions(account).pollPages ?? DEFAULT_POLL_PAGES;
        const threads: CommentThread[] = [];
        let token: string | undefined;
        for (let p = 0; p < pages; p++) {
          const res = await listThreads(ctx, c, token);
          threads.push(...(res.items ?? []));
          token = res.nextPageToken;
          if (!token) break;
        }

        const floor = state.since - OVERLAP_MS;
        const seen = new Set(state.recent.map(([id]) => id));
        const isNew = (cm: Comment) => published(cm) > floor && !seen.has(cm.id);
        const found: { comment: Comment; thread: CommentThread; kind: "comment" | "reply"; parent?: Comment }[] = [];
        const counts: Record<string, number> = {};
        let replyFetches = 0;

        for (const t of threads) {
          const top = t.snippet?.topLevelComment;
          if (top && isNew(top)) found.push({ comment: top, thread: t, kind: "comment" });
          let replies = t.replies?.comments ?? [];
          const total = t.snippet?.totalReplyCount ?? replies.length;
          const before = state.counts[t.id];
          if (total > replies.length && (before === undefined || total > before) && replyFetches < MAX_REPLY_FETCHES) {
            replyFetches++;
            try {
              replies = await listReplies(ctx, c, t.id);
            } catch (err) {
              ctx.log.error(`[youtube] couldn't load all replies on thread ${t.id}`, err);
            }
          }
          for (const r of replies) if (isNew(r)) found.push({ comment: r, thread: t, kind: "reply", parent: top });
          counts[t.id] = total;
        }

        // Everything seen (including our own comments) stays in `recent` until it leaves the window.
        const nextRecent: [string, number][] = [...state.recent, ...found.map((f): [string, number] => [f.comment.id, published(f.comment)])]
          .filter(([, at]) => at > now - OVERLAP_MS)
          .slice(-MAX_RECENT);

        const fresh = found
          .filter((f) => (f.comment.snippet?.authorChannelId?.value ?? "") !== c.channelId)
          .sort((a, b) => published(a.comment) - published(b.comment));
        if (fresh.length) await videoTitles(ctx, c, fresh.map((f) => f.comment.snippet?.videoId ?? f.thread.snippet?.videoId ?? "").filter(Boolean));
        const items = fresh.map((f) => toItem(f.comment, f.thread, f.kind, f.parent));
        return { items, cursor: JSON.stringify({ v: 1, since: now, recent: nextRecent, counts } satisfies Cursor) };
      },
    },
  };
}

export { YouTubeApiError } from "./youtube/client";
export const youtubeAdapter: PlatformAdapter = createYouTubeAdapter();
