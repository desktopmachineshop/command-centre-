import { z } from "zod";

/**
 * The contract every social platform adapter implements. The core of
 * `@cc/social` (accounts, inbound runner, publishing executors, scheduling)
 * only talks to platforms through `PlatformAdapter`, so platforms can be added
 * or swapped without touching the pipeline.
 */

export const Platform = z.enum(["discord", "instagram", "threads", "x", "reddit", "youtube"]);
export type Platform = z.infer<typeof Platform>;

export const SocialAccount = z.object({
  /** Stable id, used in dedupe keys, checkpoints and action payloads, e.g. "3dp-instagram". */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "id must be letters, digits, - or _"),
  platform: Platform,
  /** Vertical (business) this account speaks for, e.g. "dms" or "3dpandme". */
  vertical: z.string().min(1),
  /** The account's public name/handle, used in prompts and the UI. */
  handle: z.string().optional(),
  displayName: z.string().optional(),
  /** Watch this account for mentions, comments, replies and DMs. */
  inbound: z.boolean().default(true),
  /** Platform credentials; each adapter validates its own shape with `adapter.credentials`. */
  credentials: z.record(z.string(), z.string()),
  /** Platform-specific settings (e.g. Discord channel ids to watch, Reddit subreddits). */
  options: z.record(z.string(), z.unknown()).default({}),
});
export type SocialAccount = z.infer<typeof SocialAccount>;
export type SocialAccountInput = z.input<typeof SocialAccount>;

/** Media the adapter can fetch from a public URL (the server hosts uploads at an unguessable URL). */
export interface MediaRef {
  url: string;
  type: "image" | "video";
  alt?: string;
}

/** One post to publish on one account. Fields an adapter doesn't support are rejected by `validate`. */
export interface PostContent {
  text: string;
  media?: MediaRef[];
  /** A link to attach (Reddit link post, Discord embed). Platforms without link fields get it in the text. */
  link?: string;
  /** Required by Reddit (post title) and YouTube (video title). */
  title?: string;
  /** Where to post when the platform needs it: Reddit subreddit name, Discord channel id. */
  target?: string;
  /** Adapter-specific extras (e.g. Reddit flair, Instagram "reel", YouTube privacyStatus/tags). */
  options?: Record<string, unknown>;
}

export interface PublishResult {
  /** Platform id of the created post/reply/message. */
  id: string;
  url?: string;
}

export type InboundKind = "mention" | "comment" | "reply" | "dm" | "message";

/**
 * Opaque handle an adapter gives each inbound item so a later `reply` call can
 * answer it. Must be JSON-serialisable: it travels through agent prompts and
 * proposal payloads.
 */
export interface ReplyTarget {
  platform: Platform;
  kind: InboundKind;
  /** The platform id being replied to. */
  id: string;
  [key: string]: unknown;
}

/** Something that arrived on a watched account and may need a response. */
export interface InboundItem {
  /** Platform-unique, stable id; used for dedupe. */
  id: string;
  kind: InboundKind;
  author: { id: string; name?: string; handle?: string; url?: string };
  text: string;
  url?: string;
  /** ISO timestamp. */
  createdAt: string;
  replyTarget: ReplyTarget;
  /** Where it was said: the post it's on, the parent comment, channel or subreddit. */
  context?: {
    postId?: string;
    postUrl?: string;
    postText?: string;
    parentText?: string;
    channel?: string;
    subreddit?: string;
  };
  attachments?: { type: "image" | "video" | "file"; url?: string; name?: string }[];
}

export interface AdapterLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

/** Everything adapters need from the outside world; injected so tests never hit real APIs. */
export interface AdapterContext {
  fetch: typeof fetch;
  log: AdapterLogger;
  now(): Date;
  signal?: AbortSignal;
}

export interface PollResult {
  /** New items, oldest first. */
  items: InboundItem[];
  /** Opaque cursor to pass to the next poll (persisted by the core). */
  cursor: string | null;
}

/**
 * Inbound side of an adapter: polling (most platforms) or a live connection
 * (Discord gateway). Implement one of the two.
 */
export interface InboundSource {
  /**
   * Fetch items newer than `cursor`. With a null cursor (first run), return no
   * backlog: just establish a cursor at "now" so old history isn't replayed.
   */
  poll?(account: SocialAccount, cursor: string | null, ctx: AdapterContext): Promise<PollResult>;
  /** Suggested poll interval for this platform, in seconds (rate limits differ a lot). */
  pollIntervalSeconds?: number;
  /** Open a live connection and call `emit` for each item. Resolves to a stop function. */
  listen?(
    account: SocialAccount,
    emit: (item: InboundItem) => Promise<void>,
    ctx: AdapterContext,
  ): Promise<() => Promise<void>>;
}

export interface AdapterCapabilities {
  publish: boolean;
  reply: boolean;
  dm: boolean;
  /** False when the account's API tier can't read (e.g. X free tier). */
  inbound: boolean;
  media: ("image" | "video")[];
  maxTextLength: number;
  /** Instagram: a post needs at least one image or video. */
  requiresMedia?: boolean;
  /** Reddit and YouTube: posts need a title. Reddit also needs a subreddit `target`. */
  requiresTitle?: boolean;
  requiresTarget?: boolean;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: AdapterCapabilities;
  /** Shape of `account.credentials` for this platform. */
  readonly credentials: z.ZodType<Record<string, string>>;
  /** Human-readable problems with `content` for this platform; empty means publishable. */
  validate(account: SocialAccount, content: PostContent): string[];
  publish(account: SocialAccount, content: PostContent, ctx: AdapterContext): Promise<PublishResult>;
  reply(account: SocialAccount, target: ReplyTarget, text: string, ctx: AdapterContext): Promise<PublishResult>;
  /**
   * Limits on how often this account may submit (post, reply, DM), when the platform or the way
   * the account is signed in calls for a person's rhythm; null for none. `account.options`
   * (`minGapMinutes`, `dailyCap`) override it. Enforced by the executors (../pacing.ts).
   */
  pacing?(account: SocialAccount): { minGapMinutes: number; dailyCap: number } | null;
  /** Send a direct message to a user (where `capabilities.dm`). */
  sendDm?(account: SocialAccount, userId: string, text: string, ctx: AdapterContext): Promise<PublishResult>;
  inbound?: InboundSource;
}

/** Shared helper for adapters: the platform's text limits and required fields. */
export function validateAgainstCapabilities(caps: AdapterCapabilities, content: PostContent): string[] {
  const problems: string[] = [];
  if (!content.text.trim() && !content.media?.length) problems.push("text or media is required");
  if ([...content.text].length > caps.maxTextLength) problems.push(`text is longer than ${caps.maxTextLength} characters`);
  for (const m of content.media ?? []) {
    if (!caps.media.includes(m.type)) problems.push(`${m.type} media is not supported`);
  }
  if (caps.requiresMedia && !content.media?.length) problems.push("at least one image or video is required");
  if (caps.requiresTitle && !content.title?.trim()) problems.push("a title is required");
  if (caps.requiresTarget && !content.target?.trim()) problems.push("a target is required");
  return problems;
}
