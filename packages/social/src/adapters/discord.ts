import { z } from "zod";
import {
  type AdapterCapabilities,
  type AdapterContext,
  type InboundItem,
  type InboundKind,
  type PlatformAdapter,
  type PostContent,
  type PublishResult,
  type ReplyTarget,
  type SocialAccount,
  validateAgainstCapabilities,
} from "../types";
import { BOT_INTENTS, DEFAULT_GATEWAY_URL, DiscordGateway, type GatewayConnector } from "./discord/gateway";
import { DiscordRest, type Sleep } from "./discord/rest";

/**
 * Discord: a bot user in Dave's servers.
 *
 * - Publish: a message in `content.target` (channel id) or `options.announceChannelId`.
 *   Images go as embeds pointing at their public URL; links go in the text (Discord unfurls them).
 * - Reply: a message reply (`message_reference`) in the item's channel.
 * - DM: open a DM channel (`POST /users/@me/channels`), then send.
 * - Inbound: a live Gateway connection (hand-rolled on Node's WebSocket; see ./discord/gateway.ts).
 *
 * Mentions in outgoing messages: user and role mentions ping, `@everyone`/`@here` never do.
 */

export const DiscordCredentials = z.object({ botToken: z.string().min(1, "botToken is required") });

export const DiscordOptions = z.object({
  /** Only handle these servers (default: every server the bot is in). */
  guildIds: z.array(z.string()).optional(),
  /** Channels whose messages all become inbound items. */
  channelIds: z.array(z.string()).optional(),
  /** Default channel for `publish` when `content.target` is empty. */
  announceChannelId: z.string().optional(),
  /** In watched channels, only messages that @mention the bot become items. */
  respondToMentionsOnly: z.boolean().optional(),
});
export type DiscordOptions = z.infer<typeof DiscordOptions>;

const MAX_TEXT = 2000;
const MAX_EMBEDS = 10;

const capabilities: AdapterCapabilities = {
  publish: true,
  reply: true,
  dm: true,
  inbound: true,
  media: ["image"],
  maxTextLength: MAX_TEXT,
};

export interface DiscordAdapterDeps {
  /** WebSocket factory; tests pass a fake gateway. */
  connect?: GatewayConnector;
  sleep?: Sleep;
  random?: () => number;
  /** How long `listen` waits for READY before resolving anyway (it keeps reconnecting in the background). */
  readyTimeoutMs?: number;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  webhook_id?: string;
  mentions?: DiscordUser[];
  attachments?: { url: string; filename: string; content_type?: string }[];
  referenced_message?: { content?: string } | null;
}

export function createDiscordAdapter(deps: DiscordAdapterDeps = {}): PlatformAdapter {
  const rest = new DiscordRest(deps.sleep);

  const token = (account: SocialAccount) => DiscordCredentials.parse(account.credentials).botToken;
  const options = (account: SocialAccount) => DiscordOptions.parse(account.options ?? {});

  const send = async (
    account: SocialAccount,
    channelId: string,
    body: Record<string, unknown>,
    ctx: AdapterContext,
    guildId?: string,
  ): Promise<PublishResult> => {
    const msg = await rest.request<DiscordMessage>(ctx, token(account), "POST", `/channels/${channelId}/messages`, body);
    return { id: msg.id, url: messageUrl(msg.guild_id ?? guildId, msg.channel_id ?? channelId, msg.id) };
  };

  const checkText = (text: string) => {
    if (!text.trim()) throw new Error("Discord message text is empty");
    if ([...text].length > MAX_TEXT) throw new Error(`Discord messages are limited to ${MAX_TEXT} characters`);
  };

  return {
    platform: "discord",
    capabilities,
    credentials: DiscordCredentials,

    validate(account, content) {
      const problems = validateAgainstCapabilities(capabilities, { ...content, text: messageText(content) });
      if (!content.target?.trim() && !optionsSafe(account).announceChannelId) {
        problems.push("a target channel id is required (or set options.announceChannelId on the account)");
      }
      if ((content.media?.length ?? 0) > MAX_EMBEDS) problems.push(`at most ${MAX_EMBEDS} images per message`);
      return problems;
    },

    async publish(account, content, ctx) {
      const channelId = content.target?.trim() || options(account).announceChannelId;
      if (!channelId) throw new Error("Discord publish needs content.target (a channel id) or options.announceChannelId");
      const text = messageText(content);
      const embeds = (content.media ?? [])
        .filter((m) => m.type === "image")
        .slice(0, MAX_EMBEDS)
        .map((m) => ({ image: { url: m.url }, ...(m.alt ? { description: m.alt.slice(0, 4096) } : {}) }));
      if (!text.trim() && !embeds.length) throw new Error("Discord message needs text or an image");
      if ([...text].length > MAX_TEXT) throw new Error(`Discord messages are limited to ${MAX_TEXT} characters`);
      return send(account, channelId, {
        content: text,
        ...(embeds.length ? { embeds } : {}),
        allowed_mentions: { parse: ["users", "roles"] },
      }, ctx);
    },

    async reply(account, target, text, ctx) {
      checkText(text);
      const channelId = typeof target.channelId === "string" ? target.channelId : undefined;
      if (!channelId) throw new Error("Discord reply target is missing channelId");
      return send(
        account,
        channelId,
        {
          content: text,
          message_reference: { message_id: target.id, fail_if_not_exists: false },
          allowed_mentions: { parse: ["users"], replied_user: true },
        },
        ctx,
        typeof target.guildId === "string" ? target.guildId : undefined,
      );
    },

    async sendDm(account, userId, text, ctx) {
      checkText(text);
      const channel = await rest.request<{ id: string }>(ctx, token(account), "POST", "/users/@me/channels", { recipient_id: userId });
      return send(account, channel.id, { content: text, allowed_mentions: { parse: ["users"] } }, ctx);
    },

    inbound: {
      async listen(account, emit, ctx) {
        const botToken = token(account);
        const opts = options(account);
        let gatewayUrl = DEFAULT_GATEWAY_URL;
        try {
          const info = await rest.request<{ url?: string }>(ctx, botToken, "GET", "/gateway/bot");
          if (info?.url) gatewayUrl = info.url;
        } catch (err) {
          // A bad token surfaces here first; anything else falls back to the default url.
          if ((err as { status?: number }).status === 401) throw err;
          ctx.log.error("[discord] GET /gateway/bot failed, using the default gateway url", err);
        }

        let botUserId: string | null = null;
        let settle: ((err?: Error) => void) | null = null;
        const ready = new Promise<void>((resolve, reject) => {
          settle = (err) => (err ? reject(err) : resolve());
        });
        const done = (err?: Error) => {
          const s = settle;
          settle = null;
          s?.(err);
        };

        const gateway = new DiscordGateway({
          token: botToken,
          intents: BOT_INTENTS,
          url: gatewayUrl,
          connect: deps.connect,
          random: deps.random,
          log: ctx.log,
          onFatal: (err) => done(err),
          onDispatch: (type, data) => {
            if (type === "READY") {
              botUserId = (data as { user: DiscordUser }).user.id;
              ctx.log.info(`[discord] ${account.id} connected as ${(data as { user: DiscordUser }).user.username}`);
              done();
              return;
            }
            if (type !== "MESSAGE_CREATE" || !botUserId) return;
            const item = toInboundItem(data as DiscordMessage, botUserId, opts);
            if (!item) return;
            emit(item).catch((err) => ctx.log.error(`[discord] failed to ingest message ${item.id}`, err));
          },
        });

        const stop = async () => {
          gateway.stop();
          done();
        };
        ctx.signal?.addEventListener("abort", () => void stop(), { once: true });
        gateway.start();

        const timeout = setTimeout(() => {
          ctx.log.info(`[discord] ${account.id} not READY yet; still connecting in the background`);
          done();
        }, deps.readyTimeoutMs ?? 30_000);
        try {
          await ready;
        } catch (err) {
          gateway.stop();
          throw err;
        } finally {
          clearTimeout(timeout);
        }
        return stop;
      },
    },
  };

  function optionsSafe(account: SocialAccount): DiscordOptions {
    const parsed = DiscordOptions.safeParse(account.options ?? {});
    return parsed.success ? parsed.data : {};
  }
}

/** The message text with `content.link` appended when it isn't already in the text. */
function messageText(content: PostContent): string {
  const text = content.text ?? "";
  if (!content.link || text.includes(content.link)) return text;
  return text.trim() ? `${text}\n${content.link}` : content.link;
}

function messageUrl(guildId: string | undefined, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

/** Decide whether a MESSAGE_CREATE is for us, and map it. Exported for tests. */
export function toInboundItem(msg: DiscordMessage, botUserId: string, opts: DiscordOptions): InboundItem | null {
  if (!msg?.author || msg.author.bot || msg.webhook_id || msg.author.id === botUserId) return null;
  const isDm = !msg.guild_id;
  if (!isDm && opts.guildIds?.length && !opts.guildIds.includes(msg.guild_id!)) return null;
  const mentioned = (msg.mentions ?? []).some((u) => u.id === botUserId);
  const watched = (opts.channelIds ?? []).includes(msg.channel_id);

  let kind: InboundKind;
  if (isDm) kind = "dm";
  else if (mentioned) kind = "mention";
  else if (watched && !opts.respondToMentionsOnly) kind = "message";
  else return null;

  const replyTarget: ReplyTarget = {
    platform: "discord",
    kind,
    id: msg.id,
    channelId: msg.channel_id,
    ...(msg.guild_id ? { guildId: msg.guild_id } : {}),
    authorId: msg.author.id,
  };
  return {
    id: msg.id,
    kind,
    author: { id: msg.author.id, name: msg.author.global_name ?? msg.author.username, handle: msg.author.username },
    text: msg.content ?? "",
    url: messageUrl(msg.guild_id, msg.channel_id, msg.id),
    createdAt: new Date(msg.timestamp).toISOString(),
    replyTarget,
    context: {
      channel: msg.channel_id,
      ...(msg.referenced_message?.content ? { parentText: msg.referenced_message.content } : {}),
    },
    ...(msg.attachments?.length
      ? {
          attachments: msg.attachments.map((a) => ({
            type: a.content_type?.startsWith("image/") ? ("image" as const) : a.content_type?.startsWith("video/") ? ("video" as const) : ("file" as const),
            url: a.url,
            name: a.filename,
          })),
        }
      : {}),
  };
}

export const discordAdapter: PlatformAdapter = createDiscordAdapter();
