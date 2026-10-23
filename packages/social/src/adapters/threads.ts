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
 * Threads adapter: the Threads API on graph.threads.com.
 *
 * Permissions: threads_basic, threads_content_publish, threads_read_replies,
 * threads_manage_replies, threads_manage_mentions (for mention polling).
 * Threads has no DM API.
 */

export const THREADS_VERSION = "v1.0";
export const THREADS_BASE = `https://graph.threads.com/${THREADS_VERSION}`;
const THREADS_REFRESH_URL = "https://graph.threads.com/refresh_access_token";

const MAX_CAROUSEL = 20;
const MAX_LINKS = 5;
const DEFAULT_RECENT_THREADS = 10;

const RENEW_HINT =
  "Threads long-lived tokens last 60 days and must be refreshed before they lapse " +
  "(GET graph.threads.com/refresh_access_token, grant_type=th_refresh_token). Once expired they cannot be refreshed: " +
  "generate a new token (Meta App Dashboard > Threads use case > User Token Generator, or the OAuth flow) " +
  "and update this account's accessToken in SOCIAL_ACCOUNTS. See docs/SETUP.md, Social > Platform setup > Threads.";

export const ThreadsCredentials = z.object({
  /** Long-lived Threads user access token (60 days, refreshable). */
  accessToken: z.string().min(1, "accessToken is required"),
  /** Numeric Threads user id (GET graph.threads.com/v1.0/me?fields=id,username). */
  threadsUserId: z.string().regex(/^\d+$/, "threadsUserId must be the numeric Threads user id"),
});
export type ThreadsCredentials = z.infer<typeof ThreadsCredentials>;

const capabilities: AdapterCapabilities = {
  publish: true,
  reply: true,
  dm: false,
  inbound: true,
  media: ["image", "video"],
  maxTextLength: 500,
};

function creds(account: SocialAccount): ThreadsCredentials {
  const parsed = ThreadsCredentials.safeParse(account.credentials);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".") || "credentials"}: ${i.message}`).join("; ");
    throw new Error(`Threads account "${account.id}" has invalid credentials (${fields})`);
  }
  return parsed.data;
}

function client(account: SocialAccount, ctx: AdapterContext): { c: ThreadsCredentials; api: GraphClient } {
  const c = creds(account);
  return { c, api: createGraphClient({ baseUrl: THREADS_BASE, accessToken: c.accessToken, label: "Threads", renewHint: RENEW_HINT, ctx }) };
}

/**
 * Text-only posts carry `link` as a `link_attachment` (a preview card); posts
 * with media get it appended to the text.
 */
function textFor(content: PostContent): { text: string; linkAttachment?: string } {
  const text = content.text.trim();
  const link = content.link;
  if (!link || text.includes(link)) return { text };
  if (!content.media?.length) return { text, linkAttachment: link };
  return { text: text ? `${text}\n\n${link}` : link };
}

function uniqueLinks(...texts: (string | undefined)[]): number {
  const set = new Set<string>();
  for (const t of texts) for (const m of t?.match(/https?:\/\/[^\s]+/gi) ?? []) set.add(m.replace(/[.,!?)]+$/, ""));
  return set.size;
}

function validate(_account: SocialAccount, content: PostContent): string[] {
  const { text, linkAttachment } = textFor(content);
  const problems = validateAgainstCapabilities(capabilities, { ...content, text: text || linkAttachment || "" });
  const media = content.media ?? [];
  if (media.length > MAX_CAROUSEL) problems.push(`at most ${MAX_CAROUSEL} images/videos per carousel`);
  for (const m of media) if (!/^https?:\/\//i.test(m.url)) problems.push(`media must be at a public http(s) URL: ${m.url}`);
  if (uniqueLinks(text, linkAttachment) > MAX_LINKS) problems.push(`at most ${MAX_LINKS} unique links per post`);
  return problems;
}

async function checkPublishingLimit(api: GraphClient, userId: string): Promise<void> {
  const res = await api.get<{ data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[] }>(
    `/${userId}/threads_publishing_limit`,
    { fields: "quota_usage,config" },
  );
  const row = res.data?.[0];
  const used = row?.quota_usage;
  const total = row?.config?.quota_total;
  if (typeof used === "number" && typeof total === "number" && used >= total) {
    const hours = Math.round((row?.config?.quota_duration ?? 86400) / 3600);
    throw new MetaApiError(`Threads publishing limit reached: ${used}/${total} posts in the last ${hours}h; retry later (the window is rolling)`, {
      kind: "rate_limit",
    });
  }
}

async function createContainer(api: GraphClient, userId: string, params: Params): Promise<string> {
  const res = await api.post<{ id?: string }>(`/${userId}/threads`, params);
  if (!res.id) throw new MetaApiError("Threads did not return a media container id", { kind: "server" });
  return res.id;
}

function waitReady(api: GraphClient, id: string, ctx: AdapterContext): Promise<void> {
  return waitForContainer(
    "Threads",
    id,
    async () => {
      const r = await api.get<{ status?: string; error_message?: string }>(`/${id}`, { fields: "status,error_message" });
      return { status: r.status, error: r.error_message };
    },
    ctx,
  );
}

async function publishContainer(api: GraphClient, userId: string, containerId: string, ctx: AdapterContext): Promise<PublishResult> {
  await waitReady(api, containerId, ctx);
  const r = await api.post<{ id?: string }>(`/${userId}/threads_publish`, { creation_id: containerId });
  if (!r.id) throw new MetaApiError("Threads threads_publish did not return a media id", { kind: "server" });
  let url: string | undefined;
  try {
    url = (await api.get<{ permalink?: string }>(`/${r.id}`, { fields: "permalink" })).permalink;
  } catch (e) {
    ctx.log.error(`Threads: published ${r.id} but could not read its permalink`, e);
  }
  return { id: r.id, url };
}

function extras(content: PostContent): Params {
  const o = content.options ?? {};
  return {
    reply_control: typeof o.replyControl === "string" ? o.replyControl : undefined,
    topic_tag: typeof o.topicTag === "string" ? o.topicTag : undefined,
  };
}

async function publish(account: SocialAccount, content: PostContent, ctx: AdapterContext): Promise<PublishResult> {
  const problems = validate(account, content);
  if (problems.length) throw new Error(`Threads post is not publishable: ${problems.join("; ")}`);
  const { c, api } = client(account, ctx);
  const uid = c.threadsUserId;
  const media = content.media ?? [];
  const { text, linkAttachment } = textFor(content);
  const body = text || undefined;

  await checkPublishingLimit(api, uid);

  let containerId: string;
  if (media.length === 0) {
    containerId = await createContainer(api, uid, { media_type: "TEXT", text: body, link_attachment: linkAttachment, ...extras(content) });
  } else if (media.length === 1) {
    const m = media[0]!;
    containerId = await createContainer(api, uid, {
      media_type: m.type === "image" ? "IMAGE" : "VIDEO",
      ...(m.type === "image" ? { image_url: m.url } : { video_url: m.url }),
      text: body,
      alt_text: m.alt,
      ...extras(content),
    });
  } else {
    const children: string[] = [];
    for (const m of media) {
      const id = await createContainer(api, uid, {
        media_type: m.type === "image" ? "IMAGE" : "VIDEO",
        ...(m.type === "image" ? { image_url: m.url } : { video_url: m.url }),
        is_carousel_item: true,
        alt_text: m.alt,
      });
      if (m.type === "video") await waitReady(api, id, ctx);
      children.push(id);
    }
    containerId = await createContainer(api, uid, { media_type: "CAROUSEL", children: children.join(","), text: body, ...extras(content) });
  }
  return publishContainer(api, uid, containerId, ctx);
}

async function reply(account: SocialAccount, target: ReplyTarget, text: string, ctx: AdapterContext): Promise<PublishResult> {
  if (target.platform !== "threads") throw new Error(`Threads cannot reply to a ${target.platform} target`);
  if (target.kind === "dm") throw new Error("Threads has no direct messages");
  if (!text.trim()) throw new Error("Threads reply text is empty");
  if ([...text].length > capabilities.maxTextLength) throw new Error(`Threads reply is longer than ${capabilities.maxTextLength} characters`);
  if (uniqueLinks(text) > MAX_LINKS) throw new Error(`Threads reply has more than ${MAX_LINKS} unique links`);
  const { c, api } = client(account, ctx);
  const containerId = await createContainer(api, c.threadsUserId, { media_type: "TEXT", text, reply_to_id: target.id });
  return publishContainer(api, c.threadsUserId, containerId, ctx);
}

// ---------- inbound ----------

interface ThreadsMedia {
  id: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
  has_replies?: boolean;
  is_reply_owned_by_me?: boolean;
  replied_to?: { id: string };
  root_post?: { id: string };
}

const REPLY_FIELDS = "id,text,username,permalink,timestamp,replied_to,root_post,is_reply_owned_by_me";

function isOwn(account: SocialAccount, m: ThreadsMedia): boolean {
  const handle = account.handle?.replace(/^@/, "").toLowerCase();
  return m.is_reply_owned_by_me === true || (!!handle && m.username?.toLowerCase() === handle);
}

function toItem(m: ThreadsMedia, kind: "reply" | "mention", ctx: AdapterContext, post?: ThreadsMedia, parentText?: string): InboundItem {
  return {
    id: m.id,
    kind,
    author: {
      id: m.username ?? "unknown", // the Threads API does not expose other users' ids on replies/mentions
      handle: m.username,
      url: m.username ? `https://www.threads.com/@${m.username}` : undefined,
    },
    text: m.text ?? "",
    url: m.permalink,
    createdAt: toIso(m.timestamp, ctx.now()),
    replyTarget: { platform: "threads", kind, id: m.id, ...(post ? { rootId: post.id } : {}) },
    context: post ? { postId: post.id, postUrl: post.permalink, postText: post.text, parentText } : undefined,
  };
}

function isPermissionOrUnsupported(e: unknown): boolean {
  return e instanceof MetaApiError && (e.kind === "permission" || e.kind === "not_found" || (e.kind === "invalid" && e.code === 100));
}

async function poll(account: SocialAccount, cursor: string | null, ctx: AdapterContext) {
  const prev = parseCursor<SeenCursor>(cursor);
  if (!prev) {
    const fresh: SeenCursor = { v: 1, since: ctx.now().toISOString(), seen: [] };
    return { items: [], cursor: JSON.stringify(fresh) };
  }
  const since = prev.since!;
  const seen = prev.seen ?? [];
  const { c, api } = client(account, ctx);
  const uid = c.threadsUserId;
  const limit = Number(account.options.recentThreads ?? DEFAULT_RECENT_THREADS) || DEFAULT_RECENT_THREADS;
  const items: InboundItem[] = [];

  // Replies (nested too) on the account's recent threads.
  const posts = await api.get<{ data?: ThreadsMedia[] }>(`/${uid}/threads`, { fields: "id,text,permalink,timestamp,has_replies", limit });
  for (const post of posts.data ?? []) {
    if (post.has_replies === false) continue;
    const conv = await api.get<{ data?: ThreadsMedia[] }>(`/${post.id}/conversation`, { fields: REPLY_FIELDS, reverse: true, limit: 50 });
    const byId = new Map((conv.data ?? []).map((r) => [r.id, r]));
    for (const r of conv.data ?? []) {
      if (isOwn(account, r)) continue;
      const parentId = r.replied_to?.id;
      const parentText = parentId && parentId !== post.id ? byId.get(parentId)?.text : undefined;
      items.push(toItem(r, "reply", ctx, post, parentText));
    }
  }

  // Mentions (needs threads_manage_mentions; without advanced access only app testers' mentions come back).
  if (account.options.pollMentions !== false) {
    try {
      const mentions = await api.get<{ data?: ThreadsMedia[] }>(`/${uid}/mentions`, {
        fields: "id,text,username,permalink,timestamp",
        since: Math.floor(Date.parse(since) / 1000),
        limit: 50,
      });
      for (const m of mentions.data ?? []) if (!isOwn(account, m)) items.push(toItem(m, "mention", ctx));
    } catch (e) {
      if (!isPermissionOrUnsupported(e)) throw e;
      ctx.log.error(`Threads: could not read mentions for "${account.id}" (needs threads_manage_mentions); set options.pollMentions=false to stop trying`, e);
    }
  }

  const next = takeNew(items, since, seen);
  return { items: next.fresh, cursor: JSON.stringify({ v: 1, since: next.since, seen: next.seen } satisfies SeenCursor) };
}

// ---------- token refresh ----------

export async function refreshThreadsToken(accessToken: string, ctx: AdapterContext): Promise<{ accessToken: string; expiresInSeconds: number; expiresAt: string }> {
  const api = createGraphClient({ baseUrl: THREADS_REFRESH_URL, accessToken, label: "Threads", renewHint: RENEW_HINT, ctx });
  const r = await api.get<{ access_token?: string; expires_in?: number }>("", { grant_type: "th_refresh_token" });
  if (!r.access_token) throw new MetaApiError("Threads token refresh did not return a token", { kind: "server" });
  const expiresIn = r.expires_in ?? 60 * 86400;
  return { accessToken: r.access_token, expiresInSeconds: expiresIn, expiresAt: new Date(ctx.now().getTime() + expiresIn * 1000).toISOString() };
}

export const threadsAdapter: PlatformAdapter & {
  /** Refresh the account's long-lived token; returns the new credentials to persist. */
  refreshCredentials(account: SocialAccount, ctx: AdapterContext): Promise<{ credentials: ThreadsCredentials; expiresAt: string }>;
} = {
  platform: "threads",
  capabilities,
  credentials: ThreadsCredentials,
  validate,
  publish,
  reply,
  inbound: {
    poll,
    // 1 + up to 10 conversation reads + 1 mentions call per poll (~3.5k/day), inside 4800 x impressions (min 10).
    pollIntervalSeconds: 300,
  },
  async refreshCredentials(account, ctx) {
    const c = creds(account);
    const t = await refreshThreadsToken(c.accessToken, ctx);
    return { credentials: { ...c, accessToken: t.accessToken }, expiresAt: t.expiresAt };
  },
};
