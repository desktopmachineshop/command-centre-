import { z } from "zod";
import {
  type AdapterCapabilities,
  type AdapterContext,
  type InboundItem,
  type PlatformAdapter,
  type PostContent,
  type PublishResult,
  type ReplyTarget,
  type SocialAccount,
  validateAgainstCapabilities,
} from "../types";
import {
  createGraphClient,
  type GraphClient,
  MetaApiError,
  type Params,
  parseCursor,
  type SeenCursor,
  takeNew,
  toIso,
  waitForContainer,
} from "./meta/graph";

/**
 * Instagram adapter: "Instagram API with Instagram Login" (Business Login for
 * Instagram) on graph.instagram.com. Works for Business and Creator accounts and
 * does not need a linked Facebook Page.
 *
 * Permissions: instagram_business_basic, instagram_business_content_publish,
 * instagram_business_manage_comments, instagram_business_manage_messages.
 */

export const IG_GRAPH_VERSION = "v26.0";
export const IG_GRAPH_BASE = `https://graph.instagram.com/${IG_GRAPH_VERSION}`;
const IG_REFRESH_URL = "https://graph.instagram.com/refresh_access_token";

const MAX_CAROUSEL = 20; // current docs: carousels hold up to 20 items (was 10)
const MAX_HASHTAGS = 30;
const MAX_MENTIONS = 20;
const MAX_ALT_TEXT = 1000;
const MAX_DM_BYTES = 1000;
const DEFAULT_RECENT_MEDIA = 10;

const RENEW_HINT =
  "Instagram long-lived tokens last 60 days and must be refreshed before they lapse " +
  "(GET graph.instagram.com/refresh_access_token, grant_type=ig_refresh_token). Once expired they cannot be refreshed: " +
  "generate a new token in the Meta App Dashboard (Instagram > API setup with Instagram login > Generate token) " +
  "and update this account's accessToken in SOCIAL_ACCOUNTS. See docs/SETUP.md, Social > Platform setup > Instagram.";

export const InstagramCredentials = z.object({
  /** Long-lived Instagram User access token (60 days, refreshable). */
  accessToken: z.string().min(1, "accessToken is required"),
  /** The professional account's Instagram user id (`user_id` from GET /me?fields=user_id,username). */
  igUserId: z.string().regex(/^\d+$/, "igUserId must be the numeric Instagram professional account id"),
});
export type InstagramCredentials = z.infer<typeof InstagramCredentials>;

const capabilities: AdapterCapabilities = {
  publish: true,
  reply: true,
  dm: true,
  inbound: true,
  media: ["image", "video"],
  maxTextLength: 2200,
  requiresMedia: true,
};

function creds(account: SocialAccount): InstagramCredentials {
  const parsed = InstagramCredentials.safeParse(account.credentials);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".") || "credentials"}: ${i.message}`).join("; ");
    throw new Error(`Instagram account "${account.id}" has invalid credentials (${fields})`);
  }
  return parsed.data;
}

function client(account: SocialAccount, ctx: AdapterContext): { c: InstagramCredentials; api: GraphClient } {
  const c = creds(account);
  return { c, api: createGraphClient({ baseUrl: IG_GRAPH_BASE, accessToken: c.accessToken, label: "Instagram", renewHint: RENEW_HINT, ctx }) };
}

/** Instagram has no link field: links go at the end of the caption (they are not clickable there). */
function captionFor(content: PostContent): string {
  const text = content.text.trim();
  if (!content.link || text.includes(content.link)) return text;
  return text ? `${text}\n\n${content.link}` : content.link;
}

function optString(o: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === "string" && v ? v : undefined;
}

function validate(_account: SocialAccount, content: PostContent): string[] {
  const caption = captionFor(content);
  const problems = validateAgainstCapabilities(capabilities, { ...content, text: caption });
  const media = content.media ?? [];
  if (media.length > MAX_CAROUSEL) problems.push(`at most ${MAX_CAROUSEL} images/videos per carousel`);
  if ((caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length > MAX_HASHTAGS) problems.push(`at most ${MAX_HASHTAGS} hashtags`);
  if ((caption.match(/(^|\s)@[\w.]+/g) ?? []).length > MAX_MENTIONS) problems.push(`at most ${MAX_MENTIONS} @mentions`);
  for (const m of media) {
    if (!/^https?:\/\//i.test(m.url)) problems.push(`media must be at a public http(s) URL: ${m.url}`);
    if (m.type === "image" && /\.(png|gif|webp|heic|avif|bmp)(\?|#|$)/i.test(m.url)) problems.push(`Instagram only accepts JPEG images: ${m.url}`);
    if (m.alt && [...m.alt].length > MAX_ALT_TEXT) problems.push(`alt text is longer than ${MAX_ALT_TEXT} characters`);
  }
  return problems;
}

async function checkPublishingLimit(api: GraphClient, igUserId: string): Promise<void> {
  const res = await api.get<{ data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[] }>(
    `/${igUserId}/content_publishing_limit`,
    { fields: "quota_usage,config" },
  );
  const row = res.data?.[0];
  const used = row?.quota_usage;
  const total = row?.config?.quota_total;
  if (typeof used === "number" && typeof total === "number" && used >= total) {
    const hours = Math.round((row?.config?.quota_duration ?? 86400) / 3600);
    throw new MetaApiError(
      `Instagram content publishing limit reached: ${used}/${total} API posts in the last ${hours}h; retry later (the window is rolling)`,
      { kind: "rate_limit" },
    );
  }
}

async function createContainer(api: GraphClient, igUserId: string, params: Params): Promise<string> {
  const res = await api.post<{ id?: string }>(`/${igUserId}/media`, params);
  if (!res.id) throw new MetaApiError("Instagram did not return a media container id", { kind: "server" });
  return res.id;
}

function waitReady(api: GraphClient, id: string, ctx: AdapterContext): Promise<void> {
  return waitForContainer(
    "Instagram",
    id,
    async () => {
      const r = await api.get<{ status_code?: string; status?: string }>(`/${id}`, { fields: "status_code,status" });
      return { status: r.status_code, error: r.status };
    },
    ctx,
  );
}

async function publish(account: SocialAccount, content: PostContent, ctx: AdapterContext): Promise<PublishResult> {
  const problems = validate(account, content);
  if (problems.length) throw new Error(`Instagram post is not publishable: ${problems.join("; ")}`);
  const { c, api } = client(account, ctx);
  const media = content.media ?? [];
  const caption = captionFor(content) || undefined;
  const opts = content.options;

  await checkPublishingLimit(api, c.igUserId);

  let containerId: string;
  if (media.length === 1) {
    const m = media[0]!;
    if (m.type === "image") {
      containerId = await createContainer(api, c.igUserId, { image_url: m.url, caption, alt_text: m.alt });
    } else {
      // Feed videos are published as reels (media_type VIDEO is no longer accepted for single posts).
      const shareToFeed = opts?.shareToFeed;
      containerId = await createContainer(api, c.igUserId, {
        media_type: "REELS",
        video_url: m.url,
        caption,
        share_to_feed: typeof shareToFeed === "boolean" ? shareToFeed : undefined,
        cover_url: optString(opts, "coverUrl"),
        thumb_offset: typeof opts?.thumbOffset === "number" ? opts.thumbOffset : undefined,
      });
    }
  } else {
    const children: string[] = [];
    for (const m of media) {
      const id =
        m.type === "image"
          ? await createContainer(api, c.igUserId, { image_url: m.url, is_carousel_item: true, alt_text: m.alt })
          : await createContainer(api, c.igUserId, { media_type: "VIDEO", video_url: m.url, is_carousel_item: true });
      if (m.type === "video") await waitReady(api, id, ctx);
      children.push(id);
    }
    containerId = await createContainer(api, c.igUserId, { media_type: "CAROUSEL", children: children.join(","), caption });
  }

  await waitReady(api, containerId, ctx);
  const published = await api.post<{ id?: string }>(`/${c.igUserId}/media_publish`, { creation_id: containerId });
  if (!published.id) throw new MetaApiError("Instagram media_publish did not return a media id", { kind: "server" });
  const url = await permalink(api, published.id, ctx);
  return { id: published.id, url };
}

async function permalink(api: GraphClient, id: string, ctx: AdapterContext): Promise<string | undefined> {
  try {
    const r = await api.get<{ permalink?: string }>(`/${id}`, { fields: "permalink" });
    return r.permalink;
  } catch (e) {
    // The post is live; a failed permalink lookup must not turn a success into a failure (and a retry into a duplicate).
    ctx.log.error(`Instagram: published ${id} but could not read its permalink`, e);
    return undefined;
  }
}

async function sendDm(account: SocialAccount, userId: string, text: string, ctx: AdapterContext): Promise<PublishResult> {
  if (!text.trim()) throw new Error("Instagram DM text is empty");
  if (Buffer.byteLength(text, "utf8") > MAX_DM_BYTES) throw new Error(`Instagram DM text is longer than ${MAX_DM_BYTES} bytes`);
  const { c, api } = client(account, ctx);
  try {
    const r = await api.postJson<{ recipient_id?: string; message_id?: string }>(`/${c.igUserId}/messages`, {
      recipient: { id: userId },
      message: { text },
    });
    if (!r.message_id) throw new MetaApiError("Instagram Send API did not return a message id", { kind: "server" });
    return { id: r.message_id };
  } catch (e) {
    // 24h standard messaging window closed (code 10 / subcode 2534022; 551 = user unavailable).
    if (e instanceof MetaApiError && (e.subcode === 2534022 || e.subcode === 2018278 || e.code === 551)) {
      throw new MetaApiError(
        `Instagram DM not sent: you can only message a user within 24 hours of their last message to this account${
          e.code !== undefined ? ` (code ${e.code}${e.subcode !== undefined ? `, subcode ${e.subcode}` : ""})` : ""
        }`,
        { kind: "permission", code: e.code, subcode: e.subcode, status: e.status },
      );
    }
    throw e;
  }
}

async function reply(account: SocialAccount, target: ReplyTarget, text: string, ctx: AdapterContext): Promise<PublishResult> {
  if (target.platform !== "instagram") throw new Error(`Instagram cannot reply to a ${target.platform} target`);
  if (target.kind === "dm") return sendDm(account, target.id, text, ctx);
  if (target.kind !== "comment" && target.kind !== "reply") {
    throw new Error(`Instagram can only reply to comments and DMs, not "${target.kind}"`);
  }
  // Instagram threads are one level deep: replies to a reply go on the top-level comment, addressed to the author.
  const mention = typeof target.mention === "string" && target.mention ? `@${target.mention}` : undefined;
  const message = mention && !text.includes(mention) ? `${mention} ${text}` : text;
  if (!message.trim()) throw new Error("Instagram reply text is empty");
  if ([...message].length > capabilities.maxTextLength) throw new Error(`Instagram reply is longer than ${capabilities.maxTextLength} characters`);
  const { api } = client(account, ctx);
  const r = await api.post<{ id?: string }>(`/${target.id}/replies`, { message });
  if (!r.id) throw new MetaApiError("Instagram did not return the reply's comment id", { kind: "server" });
  return { id: r.id, url: typeof target.postUrl === "string" ? target.postUrl : undefined };
}

// ---------- inbound ----------

interface IgCursor extends SeenCursor {
  /** comments_count per media id at the last poll; unchanged media are skipped. */
  counts: Record<string, number>;
  dm: { since: string; seen: string[] };
}

interface IgUser {
  id?: string;
  username?: string;
}
interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: IgUser;
  parent_id?: string;
  replies?: { data?: IgComment[] };
}
interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  comments_count?: number;
}

const COMMENT_FIELDS = "id,text,timestamp,username,from,parent_id";

function isOwn(c: InstagramCredentials, account: SocialAccount, u: { id?: string; username?: string }): boolean {
  const handle = account.handle?.replace(/^@/, "").toLowerCase();
  return u.id === c.igUserId || (!!handle && u.username?.toLowerCase() === handle);
}

function isPermissionOrUnsupported(e: unknown): boolean {
  return e instanceof MetaApiError && (e.kind === "permission" || e.kind === "not_found" || (e.kind === "invalid" && e.code === 100));
}

async function pollComments(account: SocialAccount, c: InstagramCredentials, api: GraphClient, cur: IgCursor, ctx: AdapterContext) {
  const limit = Number(account.options.recentMedia ?? DEFAULT_RECENT_MEDIA) || DEFAULT_RECENT_MEDIA;
  const list = await api.get<{ data?: IgMedia[] }>(`/${c.igUserId}/media`, {
    fields: "id,caption,permalink,timestamp,comments_count",
    limit,
  });
  const counts: Record<string, number> = {};
  const items: InboundItem[] = [];
  for (const m of list.data ?? []) {
    const count = m.comments_count ?? 0;
    if (count === 0 || cur.counts[m.id] === count) {
      counts[m.id] = count;
      continue;
    }
    const res = await api.get<{ data?: IgComment[] }>(`/${m.id}/comments`, {
      fields: `${COMMENT_FIELDS},replies{${COMMENT_FIELDS}}`,
      limit: 50,
    });
    counts[m.id] = count;
    const push = (cm: IgComment, parent?: IgComment) => {
      const author = { id: cm.from?.id ?? "", username: cm.from?.username ?? cm.username };
      if (isOwn(c, account, author)) return;
      const createdAt = toIso(cm.timestamp, ctx.now());
      items.push({
        id: cm.id,
        kind: "comment",
        author: { id: author.id || author.username || "unknown", handle: author.username, url: author.username ? `https://www.instagram.com/${author.username}/` : undefined },
        text: cm.text ?? "",
        url: m.permalink,
        createdAt,
        replyTarget: {
          platform: "instagram",
          kind: "comment",
          // Replies can only hang off top-level comments.
          id: parent?.id ?? cm.parent_id ?? cm.id,
          commentId: cm.id,
          ...(parent || cm.parent_id ? { mention: author.username } : {}),
          mediaId: m.id,
          postUrl: m.permalink,
        },
        context: { postId: m.id, postUrl: m.permalink, postText: m.caption, parentText: parent?.text },
      });
    };
    for (const cm of res.data ?? []) {
      push(cm);
      for (const r of cm.replies?.data ?? []) push(r, cm);
    }
  }
  return { items, counts };
}

interface IgMessage {
  id: string;
  created_time?: string | number;
  from?: IgUser;
  message?: string;
}

async function pollDms(c: InstagramCredentials, account: SocialAccount, api: GraphClient, dmSince: string, ctx: AdapterContext) {
  const convs = await api.get<{ data?: { id: string; updated_time?: string | number }[] }>(`/${c.igUserId}/conversations`, {
    platform: "instagram",
    fields: "id,updated_time",
    limit: 20,
  });
  const items: InboundItem[] = [];
  const sinceMs = Date.parse(dmSince);
  for (const conv of convs.data ?? []) {
    if (Date.parse(toIso(conv.updated_time, ctx.now())) < sinceMs) continue;
    const res = await api.get<{ messages?: { data?: IgMessage[] } }>(`/${conv.id}`, {
      fields: "messages.limit(20){id,created_time,from,message}",
    });
    for (const msg of res.messages?.data ?? []) {
      if (!msg.from?.id || isOwn(c, account, msg.from)) continue;
      items.push({
        id: msg.id,
        kind: "dm",
        author: { id: msg.from.id, handle: msg.from.username, url: msg.from.username ? `https://www.instagram.com/${msg.from.username}/` : undefined },
        text: msg.message ?? "",
        createdAt: toIso(msg.created_time, ctx.now()),
        replyTarget: { platform: "instagram", kind: "dm", id: msg.from.id, conversationId: conv.id },
        context: { channel: conv.id },
      });
    }
  }
  return items;
}

async function poll(account: SocialAccount, cursor: string | null, ctx: AdapterContext) {
  const prev = parseCursor<IgCursor>(cursor);
  const nowIso = ctx.now().toISOString();
  if (!prev) {
    // First run: no backlog, just start the clock now.
    const fresh: IgCursor = { v: 1, since: nowIso, seen: [], counts: {}, dm: { since: nowIso, seen: [] } };
    return { items: [], cursor: JSON.stringify(fresh) };
  }
  const cur: IgCursor = {
    v: 1,
    since: prev.since ?? nowIso,
    seen: prev.seen ?? [],
    counts: prev.counts ?? {},
    dm: prev.dm ?? { since: prev.since ?? nowIso, seen: [] },
  };
  const { c, api } = client(account, ctx);

  const comments = await pollComments(account, c, api, cur, ctx);
  const nextComments = takeNew(comments.items, cur.since, cur.seen);

  let dmItems: InboundItem[] = [];
  let nextDm = cur.dm;
  if (account.options.pollDms !== false) {
    try {
      const raw = await pollDms(c, account, api, cur.dm.since, ctx);
      const t = takeNew(raw, cur.dm.since, cur.dm.seen);
      dmItems = t.fresh;
      nextDm = { since: t.since, seen: t.seen };
    } catch (e) {
      if (!isPermissionOrUnsupported(e)) throw e;
      ctx.log.error(
        `Instagram: could not read DMs for "${account.id}" (needs instagram_business_manage_messages and "Allow access to messages" in the Instagram app); set options.pollDms=false to stop trying`,
        e,
      );
    }
  }

  const next: IgCursor = { v: 1, since: nextComments.since, seen: nextComments.seen, counts: comments.counts, dm: nextDm };
  const items = [...nextComments.fresh, ...dmItems].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { items, cursor: JSON.stringify(next) };
}

// ---------- token refresh ----------

export interface RefreshedToken {
  accessToken: string;
  expiresInSeconds: number;
  expiresAt: string;
}

/**
 * Refresh a long-lived Instagram token (must be >= 24h old and not yet
 * expired). Returns a new 60-day token. Persisting it is the caller's job.
 */
export async function refreshInstagramToken(accessToken: string, ctx: AdapterContext): Promise<RefreshedToken> {
  const api = createGraphClient({ baseUrl: IG_REFRESH_URL, accessToken, label: "Instagram", renewHint: RENEW_HINT, ctx });
  const r = await api.get<{ access_token?: string; expires_in?: number }>("", { grant_type: "ig_refresh_token" });
  if (!r.access_token) throw new MetaApiError("Instagram token refresh did not return a token", { kind: "server" });
  const expiresIn = r.expires_in ?? 60 * 86400;
  return { accessToken: r.access_token, expiresInSeconds: expiresIn, expiresAt: new Date(ctx.now().getTime() + expiresIn * 1000).toISOString() };
}

export const instagramAdapter: PlatformAdapter & {
  /** Refresh the account's long-lived token; returns the new credentials to persist. */
  refreshCredentials(account: SocialAccount, ctx: AdapterContext): Promise<{ credentials: InstagramCredentials; expiresAt: string }>;
} = {
  platform: "instagram",
  capabilities,
  credentials: InstagramCredentials,
  validate,
  publish,
  reply,
  sendDm,
  inbound: {
    poll,
    // 1 media list + changed media + 1 conversations call per poll: ~1-2k calls/day, well inside 4800 x impressions.
    pollIntervalSeconds: 300,
  },
  async refreshCredentials(account, ctx) {
    const c = creds(account);
    const t = await refreshInstagramToken(c.accessToken, ctx);
    return { credentials: { ...c, accessToken: t.accessToken }, expiresAt: t.expiresAt };
  },
};
