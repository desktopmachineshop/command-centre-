import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdapterMap } from "./accounts";
import { clip, oneLine, platformLabel } from "./prompt";
import type { AdapterContext, AdapterLogger, PlatformAdapter, PostContent, PublishResult, ReplyTarget, SocialAccount } from "./types";
import { Platform } from "./types";

/**
 * Same shape as the server's `ActionExecutor`. `validate` runs when the action
 * is proposed, so a bad payload fails at once instead of after approval.
 */
export interface SocialActionExecutor {
  description: string;
  validate?(payload: Record<string, unknown>, ctx: { vertical: string }): void | Promise<void>;
  execute(payload: Record<string, unknown>, ctx?: unknown): Promise<unknown>;
}

export type SocialActionType = "social.post" | "social.reply" | "social.dm" | "social.campaign";

export type ScheduledPostStatus = "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export interface ScheduledPost {
  id: string;
  /** Posts approved together in one `social.campaign` share this. */
  campaignId: string;
  title: string;
  accountId: string;
  platform: string;
  vertical: string;
  content: PostContent;
  publishAt: string;
  status: ScheduledPostStatus;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface NewScheduledPost {
  campaignId: string;
  title: string;
  accountId: string;
  platform: string;
  vertical: string;
  content: PostContent;
  publishAt: Date;
}

/** Persistence for scheduled campaign posts. The server's Store implements this. */
export interface ScheduledPostStore {
  insertScheduledPosts(posts: NewScheduledPost[]): Promise<ScheduledPost[]>;
  /** Atomically moves due `scheduled` posts to `publishing` and returns them. */
  claimDueScheduledPosts(now: Date, limit: number): Promise<ScheduledPost[]>;
  finishScheduledPost(id: string, status: "published" | "failed", result: unknown): Promise<void>;
  /** Marks posts stuck in `publishing` (a crash mid-publish) as failed, and returns them. */
  failStaleScheduledPosts?(olderThan: Date, result: unknown): Promise<ScheduledPost[]>;
}

export interface SocialExecutorOptions {
  adapters: AdapterMap;
  /** Needed for `social.campaign` with `publishAt`. */
  scheduled?: ScheduledPostStore;
  fetch?: typeof fetch;
  logger?: AdapterLogger;
  now?: () => Date;
  /** For human-readable times in summaries and results. Default Europe/London. */
  timeZone?: string;
}

// --- Payload schemas ---

const Media = z.object({
  url: z.url({ protocol: /^https?$/, error: "media url must be an http(s) URL" }),
  type: z.enum(["image", "video"]),
  alt: z.string().optional(),
});

export const PostContentSchema = z.object({
  text: z.string(),
  media: z.array(Media).optional(),
  link: z.url({ protocol: /^https?$/ }).optional(),
  title: z.string().optional(),
  target: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const ReplyTargetSchema = z.looseObject({
  platform: Platform,
  kind: z.enum(["mention", "comment", "reply", "dm", "message"]),
  id: z.string().min(1),
});

export const PostPayload = z.object({ accountId: z.string().min(1), content: PostContentSchema });
export const ReplyPayload = z.object({ accountId: z.string().min(1), target: ReplyTargetSchema, text: z.string().trim().min(1) });
export const DmPayload = z.object({ accountId: z.string().min(1), userId: z.string().min(1), text: z.string().trim().min(1) });
export const CampaignPayload = z.object({
  title: z.string().trim().min(1),
  posts: z.array(PostPayload).min(1, "a campaign needs at least one post"),
  publishAt: z.iso.datetime({ offset: true, error: "publishAt must be an ISO date-time, e.g. 2026-10-24T18:00:00+01:00" }).optional(),
});
export type CampaignPayload = z.infer<typeof CampaignPayload>;

function parse<T>(schema: z.ZodType<T>, type: string, payload: Record<string, unknown>): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ");
    throw new Error(`Invalid ${type} payload: ${issues}`);
  }
  return result.data;
}

// --- Shared helpers ---

/** "Fri 24 Oct, 18:00" in the given zone. */
export function formatWhen(iso: string | Date, timeZone = "Europe/London"): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Platforms in order, without repeats, e.g. "Instagram, Threads and X". */
function platformList(platforms: string[]): string {
  const names = [...new Set(platforms.map(platformLabel))];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "no platforms");
}

/** A phone-friendly one-line summary for a campaign proposal. */
export function campaignSummary(
  campaign: { title: string; posts: { accountId: string }[]; publishAt?: string },
  accounts: SocialAccount[],
  timeZone = "Europe/London",
): string {
  const platforms = campaign.posts.map((p) => accounts.find((a) => a.id === p.accountId)?.platform ?? p.accountId);
  const when = campaign.publishAt ? ` · ${formatWhen(campaign.publishAt, timeZone)}` : " · now";
  return `Post "${clip(oneLine(campaign.title), 60)}" to ${platformList(platforms)}${when}`;
}

/** Problems that stop `content` being published on `account`; empty means publishable. */
export function checkPost(account: SocialAccount, adapter: PlatformAdapter | undefined, content: PostContent): string[] {
  if (!adapter) return [`no adapter for ${account.platform}`];
  if (!adapter.capabilities.publish) return [`${platformLabel(account.platform)} publishing is not supported`];
  return adapter.validate(account, content);
}

/**
 * The social action executors for the configured accounts. All are meant to
 * stay on `draft` policy: approving the proposal is the approval, including for
 * a scheduled campaign, which is not asked about again at publish time.
 */
export function createSocialExecutors(
  accounts: SocialAccount[],
  options: SocialExecutorOptions,
): Record<SocialActionType, SocialActionExecutor> {
  const { adapters } = options;
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? "Europe/London";
  const log = options.logger ?? {
    info: (m: string) => console.log(`[social] ${m}`),
    error: (m: string, err?: unknown) => console.error(`[social] ${m}`, err ?? ""),
  };
  const ids = accounts.map((a) => `${a.id} (${a.platform})`).join(", ");
  const context = (): AdapterContext => ({ fetch: options.fetch ?? fetch, log, now });

  const account = (id: string, vertical?: string) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) throw new Error(`Unknown social accountId "${id}". Configured: ${ids || "none"}`);
    if (vertical && a.vertical !== vertical) throw new Error(`Social account "${id}" belongs to ${a.vertical}, not ${vertical}`);
    return { account: a, adapter: adapters[a.platform] };
  };

  const label = (a: SocialAccount) => `${platformLabel(a.platform)}${a.handle ? ` ${a.handle.startsWith("@") ? a.handle : `@${a.handle}`}` : ""}`;

  /** Every problem in a campaign, labelled by post, or throws on the first unknown account. */
  const campaignProblems = (c: CampaignPayload, vertical?: string): string[] =>
    c.posts.flatMap((post, i) => {
      const { account: a, adapter } = account(post.accountId, vertical);
      return checkPost(a, adapter, post.content).map((p) => `post ${i + 1} (${a.id}, ${platformLabel(a.platform)}): ${p}`);
    });

  const validatePost = (payload: Record<string, unknown>, vertical?: string) => {
    const p = parse(PostPayload, "social.post", payload);
    const { account: a, adapter } = account(p.accountId, vertical);
    const problems = checkPost(a, adapter, p.content);
    if (problems.length) throw new Error(`Can't post to ${a.id} (${platformLabel(a.platform)}): ${problems.join("; ")}`);
    return { p, a, adapter: adapter! };
  };

  const validateReply = (payload: Record<string, unknown>, vertical?: string) => {
    const p = parse(ReplyPayload, "social.reply", payload);
    const { account: a, adapter } = account(p.accountId, vertical);
    if (p.target.platform !== a.platform) {
      throw new Error(`Reply target is on ${platformLabel(p.target.platform)}, but account "${a.id}" is ${platformLabel(a.platform)}`);
    }
    if (!adapter?.capabilities.reply) throw new Error(`${platformLabel(a.platform)} replies are not supported`);
    const max = adapter.capabilities.maxTextLength;
    if ([...p.text].length > max) throw new Error(`Reply is longer than ${platformLabel(a.platform)}'s ${max} characters`);
    return { p, a, adapter };
  };

  const validateDm = (payload: Record<string, unknown>, vertical?: string) => {
    const p = parse(DmPayload, "social.dm", payload);
    const { account: a, adapter } = account(p.accountId, vertical);
    if (!adapter?.capabilities.dm || !adapter.sendDm) throw new Error(`${platformLabel(a.platform)} direct messages are not supported`);
    const max = adapter.capabilities.maxTextLength;
    if ([...p.text].length > max) throw new Error(`Message is longer than ${platformLabel(a.platform)}'s ${max} characters`);
    return { p, a, adapter: adapter as PlatformAdapter & { sendDm: NonNullable<PlatformAdapter["sendDm"]> } };
  };

  const validateCampaign = (payload: Record<string, unknown>, vertical?: string) => {
    const c = parse(CampaignPayload, "social.campaign", payload);
    const problems = campaignProblems(c, vertical);
    if (problems.length) throw new Error(`Campaign "${c.title}" has invalid posts: ${problems.join("; ")}`);
    if (c.publishAt && !options.scheduled) throw new Error("Scheduling is not available on this server");
    return c;
  };

  const result = (r: PublishResult) => ({ id: r.id, url: r.url ?? null });

  return {
    "social.post": {
      description:
        'Publish one post on one social account. payload: { accountId, content: { text, media?: [{ url, type: "image"|"video", alt? }], link?, title? (Reddit post title, YouTube video title), target? (subreddit or Discord channel id), options? (platform extras, e.g. YouTube { privacyStatus, publishAt, tags, categoryId, madeForKids, thumbnailUrl }) } }. Media must be at a public URL (upload to /api/media, or use one you found). For several platforms at once, use social.campaign.',
      validate: (payload, ctx) => void validatePost(payload, ctx.vertical),
      execute: async (payload) => {
        const { p, a, adapter } = validatePost(payload);
        return result(await adapter.publish(a, p.content, context()));
      },
    },
    "social.reply": {
      description:
        "Reply to a social comment, mention or DM. payload: { accountId, target (the replyTarget from the task, unchanged), text }.",
      validate: (payload, ctx) => void validateReply(payload, ctx.vertical),
      execute: async (payload) => {
        const { p, a, adapter } = validateReply(payload);
        return result(await adapter.reply(a, p.target as ReplyTarget, p.text, context()));
      },
    },
    "social.dm": {
      description: "Send a direct message, on platforms that allow it. payload: { accountId, userId (the platform user id), text }.",
      validate: (payload, ctx) => void validateDm(payload, ctx.vertical),
      execute: async (payload) => {
        const { p, a, adapter } = validateDm(payload);
        return result(await adapter.sendDm(a, p.userId, p.text, context()));
      },
    },
    "social.campaign": {
      description:
        'One approval for the same news on several accounts (e.g. a new YouTube video on Instagram, Threads, X, Reddit and Discord). payload: { title, posts: [{ accountId, content }] (content as in social.post, written for each platform), publishAt? (ISO date-time; omit to publish on approval) }. Every post is checked up front. Summary: one short line, e.g. "Post \\"ER11 collet guide\\" to Instagram, X and Reddit · Fri 24 Oct, 18:00".',
      validate: (payload, ctx) => void validateCampaign(payload, ctx.vertical),
      execute: async (payload) => {
        const c = validateCampaign(payload);
        if (c.publishAt) {
          const campaignId = randomUUID();
          const rows = await options.scheduled!.insertScheduledPosts(
            c.posts.map((post) => {
              const { account: a } = account(post.accountId);
              return {
                campaignId,
                title: c.title,
                accountId: a.id,
                platform: a.platform,
                vertical: a.vertical,
                content: post.content,
                publishAt: new Date(c.publishAt!),
              };
            }),
          );
          return {
            status: "scheduled",
            campaignId,
            publishAt: new Date(c.publishAt).toISOString(),
            when: formatWhen(c.publishAt, timeZone),
            posts: rows.map((r) => ({ id: r.id, accountId: r.accountId, platform: r.platform })),
          };
        }

        const settled = await Promise.allSettled(
          c.posts.map(async (post) => {
            const { account: a, adapter } = account(post.accountId);
            return { a, r: await adapter!.publish(a, post.content, context()) };
          }),
        );
        const published: { accountId: string; platform: string; id: string; url: string | null }[] = [];
        const failed: { accountId: string; platform: string; error: string }[] = [];
        settled.forEach((s, i) => {
          const a = account(c.posts[i]!.accountId).account;
          if (s.status === "fulfilled") published.push({ accountId: a.id, platform: a.platform, ...result(s.value.r) });
          else {
            const error = (s.reason as Error)?.message ?? String(s.reason);
            log.error(`campaign "${c.title}": ${label(a)} failed: ${error}`);
            failed.push({ accountId: a.id, platform: a.platform, error });
          }
        });
        if (published.length === 0) {
          throw new Error(`Every post failed: ${failed.map((f) => `${f.accountId}: ${f.error}`).join("; ")}`);
        }
        return { status: failed.length ? "partial" : "published", published, failed };
      },
    },
  };
}

export interface PublishDueOptions {
  store: ScheduledPostStore;
  accounts: SocialAccount[];
  adapters: AdapterMap;
  /** Called once per failed post (the server pushes a notification). */
  onFailure?: (post: ScheduledPost, error: string) => Promise<void>;
  fetch?: typeof fetch;
  logger?: AdapterLogger;
  now?: () => Date;
  limit?: number;
  /** A post still `publishing` after this long was interrupted. Default 15 min. */
  staleMs?: number;
}

/**
 * Publishes scheduled posts that are due (run every minute by the server).
 * Each post is published once: it is claimed first, then marked published or
 * failed with the result. A post interrupted mid-publish is marked failed, not
 * retried, because it may already be live.
 */
export async function publishDueScheduledPosts(options: PublishDueOptions): Promise<{ published: number; failed: number }> {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? {
    info: (m: string) => console.log(`[social] ${m}`),
    error: (m: string, err?: unknown) => console.error(`[social] ${m}`, err ?? ""),
  };
  const ctx: AdapterContext = { fetch: options.fetch ?? fetch, log, now };
  let published = 0;
  let failed = 0;
  const fail = async (post: ScheduledPost, error: string) => {
    failed++;
    log.error(`scheduled post ${post.id} (${post.accountId}) failed: ${error}`);
    await options.onFailure?.(post, error).catch((err) => log.error("could not report a failed post", err));
  };

  const staleBefore = new Date(now().getTime() - (options.staleMs ?? 15 * 60_000));
  const interrupted = "interrupted while publishing; check the platform before posting it again";
  for (const post of (await options.store.failStaleScheduledPosts?.(staleBefore, { ok: false, error: interrupted })) ?? []) {
    await fail(post, interrupted);
  }

  const due = await options.store.claimDueScheduledPosts(now(), options.limit ?? 50);
  for (const post of due) {
    try {
      const account = options.accounts.find((a) => a.id === post.accountId);
      if (!account) throw new Error(`social account "${post.accountId}" is no longer configured`);
      const adapter = options.adapters[account.platform];
      const problems = checkPost(account, adapter, post.content);
      if (problems.length) throw new Error(problems.join("; "));
      const r = await adapter!.publish(account, post.content, ctx);
      await options.store.finishScheduledPost(post.id, "published", { ok: true, id: r.id, url: r.url ?? null });
      published++;
    } catch (err) {
      const error = (err as Error)?.message ?? String(err);
      await options.store.finishScheduledPost(post.id, "failed", { ok: false, error });
      await fail(post, error);
    }
  }
  return { published, failed };
}
