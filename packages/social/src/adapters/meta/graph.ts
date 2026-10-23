import type { AdapterContext } from "../../types";

/**
 * Small client shared by the Instagram and Threads adapters. Both are Meta
 * Graph-style APIs: the token goes in the `access_token` query/form parameter,
 * errors come back as `{ error: { message, type, code, error_subcode, fbtrace_id } }`
 * and throttling is signalled by well-known error codes plus usage headers.
 *
 * Rules this module enforces:
 * - Requests always go through the injected `ctx.fetch` (tests mock it).
 * - The access token never appears in an error message, log line or thrown
 *   error. It is scrubbed from everything we surface, including network
 *   errors that might echo the URL.
 * - Every request has a timeout (default 30s), combined with `ctx.signal`.
 */

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Graph error codes that mean "throttled" (Graph API rate-limiting docs). */
export const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 80006]);
/** Instagram's "content publishing limit reached" (code 9, subcode 2207042). */
const IG_PUBLISH_LIMIT_SUBCODE = 2207042;

export type MetaErrorKind = "rate_limit" | "auth" | "permission" | "not_found" | "invalid" | "timeout" | "network" | "server";

export class MetaApiError extends Error {
  readonly kind: MetaErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;
  /** Seconds to wait before retrying, when the API says (rate limits). */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    opts: { kind: MetaErrorKind; status?: number; code?: number; subcode?: number; fbtraceId?: string; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "MetaApiError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.fbtraceId = opts.fbtraceId;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export interface GraphClientOptions {
  /** e.g. "https://graph.instagram.com/v26.0" */
  baseUrl: string;
  accessToken: string;
  /** "Instagram" / "Threads", used in messages. */
  label: string;
  /** Appended to auth failures: how to get a fresh token. */
  renewHint: string;
  ctx: AdapterContext;
  timeoutMs?: number;
}

export type Params = Record<string, string | number | boolean | undefined>;

export interface GraphClient {
  get<T = Record<string, unknown>>(path: string, params?: Params): Promise<T>;
  /** Form-encoded POST (what the publishing endpoints document). */
  post<T = Record<string, unknown>>(path: string, params?: Params): Promise<T>;
  /** JSON POST (what the messaging Send API documents). */
  postJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T>;
}

/** Replace every occurrence of `secret` (and its URL-encoded form) with "[redacted]". */
export function redact(text: string, secret: string): string {
  if (!secret) return text;
  let out = text.split(secret).join("[redacted]");
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) out = out.split(encoded).join("[redacted]");
  // Belt and braces: any access_token=... that slipped through.
  return out.replace(/access_token=[^&\s"']+/g, "access_token=[redacted]");
}

function toSearch(params: Params): URLSearchParams {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, String(v));
  return search;
}

/** Parse `X-Business-Use-Case-Usage` / `X-App-Usage` style headers into a retry hint and peak usage %. */
export function parseUsageHeaders(headers: Headers): { maxPercent: number; retryAfterSeconds?: number } {
  let maxPercent = 0;
  let retryAfterSeconds: number | undefined;
  const visit = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visit);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "number") {
        if (k === "estimated_time_to_regain_access") {
          // Minutes, per the Graph rate-limiting docs.
          if (v > 0) retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, v * 60);
        } else if (/count|time|cputime|usage/.test(k) && k !== "ads_api_access_tier") {
          maxPercent = Math.max(maxPercent, v);
        }
      } else visit(v);
    }
  };
  for (const name of ["x-app-usage", "x-business-use-case-usage", "x-ad-account-usage"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      visit(JSON.parse(raw));
    } catch {
      /* ignore malformed header */
    }
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, Number(retryAfter));
  return { maxPercent, retryAfterSeconds };
}

interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

function describeCodes(code?: number, subcode?: number): string {
  const parts: string[] = [];
  if (code !== undefined) parts.push(`code ${code}`);
  if (subcode !== undefined) parts.push(`subcode ${subcode}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Turn a failed Graph response into a MetaApiError with a clear, token-free message. */
export function toMetaError(
  status: number,
  body: unknown,
  headers: Headers,
  opts: Pick<GraphClientOptions, "label" | "renewHint" | "accessToken">,
  what: string,
): MetaApiError {
  const err: GraphErrorBody =
    body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" ? (body.error as GraphErrorBody) : {};
  const code = typeof err.code === "number" ? err.code : undefined;
  const subcode = typeof err.error_subcode === "number" ? err.error_subcode : undefined;
  const detail = [err.error_user_title, err.error_user_msg ?? err.message].filter(Boolean).join(": ") || `HTTP ${status}`;
  const codes = describeCodes(code, subcode);
  const usage = parseUsageHeaders(headers);
  const base = { status, code, subcode, fbtraceId: err.fbtrace_id };
  const scrub = (m: string) => redact(m, opts.accessToken);

  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || (code === 9 && subcode === IG_PUBLISH_LIMIT_SUBCODE) || status === 429) {
    const retry = usage.retryAfterSeconds;
    const when = retry ? `retry after ~${Math.ceil(retry)}s` : "retry later (Meta did not say when; usually within an hour)";
    const which = code === 9 ? "content publishing limit reached" : "rate limited";
    return new MetaApiError(scrub(`${opts.label} ${which}${codes}; ${when}. ${what}: ${detail}`), {
      kind: "rate_limit",
      ...base,
      retryAfterSeconds: retry,
    });
  }
  if (code === 190 || code === 102 || status === 401) {
    const expired = subcode === 463 || /expired/i.test(err.message ?? "");
    const reason = expired ? "access token has expired" : "access token is invalid or was revoked";
    return new MetaApiError(scrub(`${opts.label} ${reason}${codes}. ${opts.renewHint}`), { kind: "auth", ...base });
  }
  if (code === 10 || code === 200 || code === 3 || (code !== undefined && code >= 200 && code < 300) || status === 403) {
    return new MetaApiError(
      scrub(`${opts.label} permission denied${codes}. ${what}: ${detail}. Check the token was granted the required permissions (see docs/SETUP.md).`),
      { kind: "permission", ...base },
    );
  }
  if (status === 404 || (code === 100 && subcode === 33)) {
    return new MetaApiError(scrub(`${opts.label} object not found${codes}. ${what}: ${detail}`), { kind: "not_found", ...base });
  }
  const kind: MetaErrorKind = status >= 500 || code === 1 || code === 2 ? "server" : "invalid";
  return new MetaApiError(scrub(`${opts.label} API error${codes}. ${what}: ${detail}`), { kind, ...base });
}

export function createGraphClient(opts: GraphClientOptions): GraphClient {
  const { ctx, accessToken, label } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(method: "GET" | "POST", path: string, query: Params, body?: { form?: Params; json?: unknown }): Promise<T> {
    const what = `${method} ${path || new URL(opts.baseUrl).pathname}`; // never includes the query string (token)
    const url = !path ? opts.baseUrl : `${opts.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const search = toSearch({ ...query, access_token: accessToken });
    let init: RequestInit = { method, headers: { accept: "application/json" } };
    let fullUrl = `${url}?${search}`;
    if (body?.form) {
      const form = toSearch({ ...body.form, access_token: accessToken });
      init = { ...init, body: form.toString(), headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" } };
      fullUrl = url;
    } else if (body?.json !== undefined) {
      init = { ...init, body: JSON.stringify(body.json), headers: { accept: "application/json", "content-type": "application/json" } };
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await ctx.fetch(fullUrl, { ...init, signal });
    } catch (e) {
      if (ctx.signal?.aborted) throw new MetaApiError(`${label} request aborted: ${what}`, { kind: "timeout" });
      if (timeout.aborted) throw new MetaApiError(`${label} request timed out after ${timeoutMs}ms: ${what}`, { kind: "timeout" });
      const msg = e instanceof Error ? e.message : String(e);
      throw new MetaApiError(redact(`${label} network error: ${what}: ${msg}`, accessToken), { kind: "network" });
    }

    const text = await res.text().catch(() => "");
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    const hasError = parsed && typeof parsed === "object" && "error" in parsed;
    if (!res.ok || hasError) {
      if (parsed === undefined) parsed = { error: { message: text.slice(0, 200) } };
      throw toMetaError(res.status, parsed, res.headers, opts, what);
    }
    const usage = parseUsageHeaders(res.headers);
    if (usage.maxPercent >= 90) ctx.log.info(`${label} API usage at ${usage.maxPercent}% of the rate limit (${what})`);
    if (parsed === undefined) throw new MetaApiError(`${label} returned a non-JSON response for ${what}`, { kind: "server", status: res.status });
    return parsed as T;
  }

  return {
    get: (path, params = {}) => request("GET", path, params),
    post: (path, params = {}) => request("POST", path, {}, { form: params }),
    postJson: (path, json) => request("POST", path, {}, { json }),
  };
}

/** Timing knobs for container status polling; tests set these to zero. */
export const metaTiming = {
  statusPollIntervalMs: 10_000,
  statusMaxAttempts: 30, // ~5 minutes, matching Meta's "poll for no more than 5 minutes"
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new MetaApiError("request aborted while waiting for media processing", { kind: "timeout" }));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll a media container until it is ready. `read` returns the platform's
 * status string (Instagram `status_code`, Threads `status`) plus an optional
 * error message.
 */
export async function waitForContainer(
  label: string,
  containerId: string,
  read: () => Promise<{ status?: string; error?: string }>,
  ctx: AdapterContext,
): Promise<void> {
  for (let attempt = 1; attempt <= metaTiming.statusMaxAttempts; attempt++) {
    const { status, error } = await read();
    switch (status) {
      case "FINISHED":
      case "PUBLISHED":
        return;
      case "ERROR":
        throw new MetaApiError(`${label} media processing failed for container ${containerId}${error ? `: ${error}` : ""}`, { kind: "invalid" });
      case "EXPIRED":
        throw new MetaApiError(`${label} media container ${containerId} expired before it was published`, { kind: "invalid" });
      default:
        if (attempt < metaTiming.statusMaxAttempts) await sleep(metaTiming.statusPollIntervalMs, ctx.signal);
    }
  }
  throw new MetaApiError(
    `${label} media container ${containerId} was still processing after ${Math.round((metaTiming.statusPollIntervalMs * metaTiming.statusMaxAttempts) / 1000)}s`,
    { kind: "timeout" },
  );
}

/** Meta timestamps look like "2026-10-23T10:00:00+0000"; normalise to ISO. */
export function toIso(ts: string | number | undefined, fallback: Date): string {
  if (ts === undefined || ts === "") return fallback.toISOString();
  if (typeof ts === "number" || /^\d+$/.test(ts)) {
    const n = Number(ts);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const d = new Date(ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? fallback.toISOString() : d.toISOString();
}

/** A JSON cursor shared by both adapters: a high-water mark plus ids seen at/after it (for same-second ties). */
export interface SeenCursor {
  v: 1;
  /** ISO time; items at or before this were already handled, except ids in `seen`. */
  since: string;
  /** Recently emitted ids, to dedupe items sharing the boundary timestamp. */
  seen: string[];
}

export const MAX_SEEN = 300;

export function parseCursor<T extends SeenCursor>(cursor: string | null): Partial<T> | null {
  if (!cursor) return null;
  try {
    const c = JSON.parse(cursor) as Partial<T>;
    return c && typeof c === "object" && typeof c.since === "string" ? c : null;
  } catch {
    return null;
  }
}

/** Keep items newer than `since` (or equal but unseen), oldest first, and advance the cursor. */
export function takeNew<I extends { id: string; createdAt: string }>(items: I[], since: string, seen: string[]): { fresh: I[]; since: string; seen: string[] } {
  const seenSet = new Set(seen);
  const sinceMs = Date.parse(since);
  const fresh = items
    .filter((i) => Date.parse(i.createdAt) >= sinceMs && !seenSet.has(i.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const dedup: I[] = [];
  const ids = new Set<string>();
  for (const i of fresh) if (!ids.has(i.id)) (ids.add(i.id), dedup.push(i));
  let next = since;
  for (const i of dedup) if (Date.parse(i.createdAt) > Date.parse(next)) next = i.createdAt;
  const nextSeen = [...seen, ...dedup.map((i) => i.id)].slice(-MAX_SEEN);
  return { fresh: dedup, since: next, seen: nextSeen };
}
