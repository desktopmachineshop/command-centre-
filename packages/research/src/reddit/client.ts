/**
 * Reads Reddit's public pages without an API app: the `.json` form of each listing, and its
 * `.rss` (Atom) feed when the JSON is refused (a 403 or a block page; never after a 429).
 *
 * It behaves like the well-mannered script it is:
 * - an honest User-Agent that says what it is (never a browser's);
 * - one request at a time, spaced out, and never more than Reddit's rate-limit headers allow;
 * - a short cache, so an agent asking twice costs one request;
 * - no retries beyond the single feed fallback: when Reddit says no, the caller is told so.
 * With a session cookie (a connected Reddit session account, see @cc/social's adapter) requests
 * carry it, which Reddit treats as that signed-in user reading. Nothing here writes.
 */

export const REDDIT_WWW = "https://www.reddit.com";
export const REDDIT_READ_USER_AGENT = "web:command-centre:1.0 (read-only research for a small business owner)";

export type Sleep = (ms: number) => Promise<void>;

export class RedditReadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RedditReadError";
  }
}

/** The JSON endpoint refused (blocked or rate limited): the caller may try the feed. */
class Refused extends RedditReadError {}

export interface RedditReaderOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: Sleep;
  userAgent?: string;
  /** A `Cookie` header value of a signed-in session, when one is connected. */
  cookie?: () => string | undefined;
  /** How long an answer is reused. Default 2 minutes. */
  cacheMs?: number;
  /** Least time between two requests. Default 1.5 s. */
  minIntervalMs?: number;
  /** Longest wait for a rate-limit window inside one call; beyond it the call fails with the wait. Default 8 s. */
  maxWaitMs?: number;
  baseUrl?: string;
}

/** One entry of an Atom feed. */
export interface AtomEntry {
  id: string;
  title: string;
  author: string | null;
  link: string | null;
  updated: string | null;
  subreddit: string | null;
  /** The entry's HTML content, as Reddit renders it. */
  html: string;
}

const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");

export function parseAtom(xml: string): AtomEntry[] {
  const tag = (block: string, name: string) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block)?.[1];
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => {
    const block = m[1]!;
    const author = tag(tag(block, "author") ?? "", "name");
    return {
      id: unescapeXml(tag(block, "id") ?? "").trim(),
      title: unescapeXml(tag(block, "title") ?? "").trim(),
      author: author ? unescapeXml(author).trim().replace(/^\/?u\//, "") : null,
      link: /<link\b[^>]*href="([^"]+)"/i.exec(block)?.[1]?.replace(/&amp;/g, "&") ?? null,
      updated: (tag(block, "updated") ?? tag(block, "published") ?? "").trim() || null,
      subreddit: /<category\b[^>]*term="([^"]+)"/i.exec(block)?.[1] ?? null,
      html: unescapeXml(tag(block, "content") ?? ""),
    };
  });
}

type Query = Record<string, string | number | undefined>;

export class RedditReader {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: Sleep;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  private holdUntil = 0;

  constructor(private readonly options: RedditReaderOptions = {}) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** True when requests carry a signed-in session's cookie. */
  get signedIn(): boolean {
    return !!this.options.cookie?.();
  }

  /**
   * GET `<path>.json`. When Reddit refuses the JSON and `feed` is given, the Atom feed at
   * `<path>.rss` is read instead and passed to `feed` to shape the same kind of answer.
   */
  async get<T>(path: string, query: Query = {}, feed?: (entries: AtomEntry[]) => T): Promise<T> {
    const key = `${path}?${new URLSearchParams(strings(query)).toString()}`;
    const hit = this.cache.get(key);
    if (hit && this.now().getTime() - hit.at < (this.options.cacheMs ?? 120_000)) return hit.value as T;
    const value = await this.serial(async () => {
      try {
        return await this.json<T>(path, query);
      } catch (err) {
        if (!(err instanceof Refused) || !feed) throw err;
        const entries = await this.atom(path, query, err);
        return feed(entries);
      }
    });
    if (this.cache.size > 300) this.cache.clear();
    this.cache.set(key, { at: this.now().getTime(), value });
    return value;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async request(url: string, accept: string): Promise<Response> {
    const now = this.now().getTime();
    const wait = Math.max(this.lastRequest + (this.options.minIntervalMs ?? 1500) - now, this.holdUntil - now, 0);
    if (wait > (this.options.maxWaitMs ?? 8000)) {
      throw new RedditReadError(`Reddit's rate limit is used up; it resets in about ${Math.ceil(wait / 1000)}s. Carry on with what you have and try again later.`, 429);
    }
    if (wait > 0) await this.sleep(wait);
    this.lastRequest = this.now().getTime();
    const cookie = this.options.cookie?.();
    let res: Response;
    try {
      res = await this.fetch(url, {
        headers: { "User-Agent": this.options.userAgent ?? REDDIT_READ_USER_AGENT, Accept: accept, ...(cookie ? { Cookie: cookie } : {}) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new RedditReadError(`Reddit could not be reached: ${(err as Error).message}`);
    }
    // Honour Reddit's own budget: when the window is spent, hold every later request until it resets.
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAfter = Number(res.headers.get("retry-after"));
    const at = this.now().getTime();
    if (res.headers.has("x-ratelimit-remaining") && remaining < 1 && Number.isFinite(reset)) this.holdUntil = at + reset * 1000;
    if (res.status === 429) this.holdUntil = Math.max(this.holdUntil, at + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Number.isFinite(reset) && reset > 0 ? reset : 60) * 1000);
    return res;
  }

  private url(path: string, ext: string, query: Query): string {
    const url = new URL(`${this.options.baseUrl ?? REDDIT_WWW}${path}${ext}`);
    for (const [k, v] of Object.entries(strings(query))) url.searchParams.set(k, v);
    return url.toString();
  }

  private async json<T>(path: string, query: Query): Promise<T> {
    const res = await this.request(this.url(path, ".json", { ...query, raw_json: 1 }), "application/json");
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const reason = (data as { reason?: unknown } | null)?.reason;
    if (res.status === 404) throw new RedditReadError(reason === "banned" ? "That subreddit is banned" : "Reddit has nothing there (check the subreddit, user or thread id)", 404);
    if (res.status === 403 && typeof reason === "string") {
      throw new RedditReadError(`Reddit won't show that: the subreddit is ${reason === "gold_only" ? "for Reddit Premium members only" : reason}`, 403);
    }
    // Rate limited: asking again another way would be the opposite of slowing down.
    if (res.status === 429) {
      const wait = Math.max(0, Math.ceil((this.holdUntil - this.now().getTime()) / 1000));
      throw new RedditReadError(`Reddit is rate limiting this server (HTTP 429); it asks for about ${wait}s. Carry on with what you have and try again later.`, 429);
    }
    if (res.status === 403) throw new Refused("Reddit refused the request (HTTP 403)", 403);
    if (!res.ok) throw new RedditReadError(`Reddit answered HTTP ${res.status}`, res.status);
    // A block page comes back as HTML with a 200.
    if (data === null) throw new Refused("Reddit answered with a page instead of data", res.status);
    return data as T;
  }

  private async atom(path: string, query: Query, why: RedditReadError): Promise<AtomEntry[]> {
    const hint = this.signedIn ? "" : " Connecting a Reddit session account on the Accounts page makes reads more reliable.";
    let res: Response;
    try {
      res = await this.request(this.url(path, ".rss", query), "application/atom+xml");
    } catch (err) {
      throw new RedditReadError(`${why.message}, and its feed could not be read either (${(err as Error).message}).${hint}`, why.status);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok || !/<feed\b/i.test(text)) {
      throw new RedditReadError(`${why.message}, and its feed too (HTTP ${res.status}). Reddit is blocking or rate limiting this server right now: try again later.${hint}`, res.status === 200 ? why.status : res.status);
    }
    return parseAtom(text);
  }
}

function strings(query: Query): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") out[k] = String(v);
  return out;
}
