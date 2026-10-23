import type { AdapterContext } from "../../types";

/** Discord REST API v10 (https://docs.discord.com/developers/reference#api-versioning). */
export const DISCORD_API = "https://discord.com/api/v10";
/** Discord requires `DiscordBot ($url, $versionNumber)` (https://docs.discord.com/developers/reference#user-agent). */
export const DISCORD_USER_AGENT = "DiscordBot (https://desktopmachineshop.com, 0.1.0) command-centre";

/** Longest we'll wait on a rate limit inside one call; anything longer fails so the job can be retried later. */
const MAX_WAIT_MS = 60_000;
const MAX_RETRIES = 3;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

/**
 * Minimal Discord REST client. Honours per-route rate limits from the
 * `X-RateLimit-Remaining` / `X-RateLimit-Reset-After` headers and retries 429s
 * after `retry_after` (https://docs.discord.com/developers/topics/rate-limits).
 * The bot token only ever goes in the Authorization header, never into errors.
 */
export class DiscordRest {
  /** Route key -> epoch ms when that route's bucket resets (set when Remaining hits 0). */
  private readonly resets = new Map<string, number>();
  /** Epoch ms until which every request waits (global 429). */
  private globalResetAt = 0;

  constructor(private readonly sleep: Sleep = realSleep) {}

  async request<T>(
    ctx: AdapterContext,
    token: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const route = `${method} ${path}`;
    for (let attempt = 0; ; attempt++) {
      await this.waitFor(route, ctx);
      const res = await ctx.fetch(`${DISCORD_API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          "User-Agent": DISCORD_USER_AGENT,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctx.signal,
      });
      this.track(route, res, ctx);

      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
        const header = Number(res.headers.get("retry-after"));
        const seconds = typeof data.retry_after === "number" ? data.retry_after : Number.isFinite(header) ? header : 1;
        const waitMs = Math.ceil(seconds * 1000);
        if (data.global || res.headers.get("x-ratelimit-global")) this.globalResetAt = ctx.now().getTime() + waitMs;
        if (attempt >= MAX_RETRIES || waitMs > MAX_WAIT_MS) {
          throw new DiscordApiError(`Discord rate limit on ${describe(route)}: retry after ${seconds}s`, 429);
        }
        ctx.log.info(`[discord] rate limited on ${describe(route)}, retrying in ${seconds}s`);
        await this.sleep(waitMs);
        continue;
      }

      if (res.status === 204) return undefined as T;
      const data = (await res.json().catch(() => null)) as T & { message?: string; code?: number };
      if (!res.ok) {
        const detail = data?.message ? `${data.message}${data.code ? ` (code ${data.code})` : ""}` : res.statusText;
        throw new DiscordApiError(`Discord API ${res.status} on ${describe(route)}: ${detail}${hint(res.status, data?.code)}`, res.status, data?.code);
      }
      return data;
    }
  }

  private async waitFor(route: string, ctx: AdapterContext): Promise<void> {
    const until = Math.max(this.globalResetAt, this.resets.get(route) ?? 0);
    const wait = until - ctx.now().getTime();
    if (wait > 0) await this.sleep(Math.min(wait, MAX_WAIT_MS));
  }

  private track(route: string, res: Response, ctx: AdapterContext): void {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
    if (remaining === "0" && Number.isFinite(resetAfter)) this.resets.set(route, ctx.now().getTime() + resetAfter * 1000);
    else if (remaining !== null) this.resets.delete(route);
  }
}

/** Route for messages, with snowflakes collapsed so logs stay readable. */
function describe(route: string): string {
  return route.replace(/\d{15,}/g, ":id");
}

function hint(status: number, code?: number): string {
  if (status === 401) return " - the bot token is invalid or was reset";
  if (code === 50001) return " - the bot can't see that channel (check it's in the server and has View Channel)";
  if (code === 50013) return " - the bot is missing a permission (Send Messages, Embed Links or Read Message History)";
  if (code === 50007) return " - the user doesn't accept DMs from this bot (no shared server, or DMs closed)";
  if (code === 10003) return " - unknown channel id";
  return "";
}
