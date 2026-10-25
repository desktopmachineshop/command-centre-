import { IG_GRAPH_BASE, REDDIT_API, REDDIT_TOKEN_URL, THREADS_BASE, X_API_BASE } from "@cc/social";
import type { OAuthProvider } from "../catalog";

/**
 * One platform's sign-in: building the authorize URL and turning the callback into Accounts-page
 * fields. Every HTTP call goes through `deps.fetch`, and the hosts are in `deps.urls` so tests can
 * point them at a fake. (Google and YouTube reuse @cc/pa and @cc/social code whose Google
 * endpoints are fixed; tests fake those through `fetch`.)
 */
export interface Endpoints {
  googleUserinfo: string;
  instagramAuthorize: string;
  /** Short-lived token exchange (form POST). */
  instagramToken: string;
  /** graph.instagram.com: the long-lived token exchange (`/access_token`). */
  instagramGraph: string;
  /** The adapter's versioned Graph base, for `/me`. */
  instagramApi: string;
  threadsAuthorize: string;
  /** graph.threads.net: `/oauth/access_token` and `/access_token` (long-lived exchange). */
  threadsGraph: string;
  threadsApi: string;
  xApi: string;
  redditAuthorize: string;
  redditToken: string;
  redditApi: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = {
  googleUserinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  instagramAuthorize: "https://www.instagram.com/oauth/authorize",
  instagramToken: "https://api.instagram.com/oauth/access_token",
  instagramGraph: "https://graph.instagram.com",
  instagramApi: IG_GRAPH_BASE,
  threadsAuthorize: "https://threads.net/oauth/authorize",
  threadsGraph: "https://graph.threads.net",
  threadsApi: THREADS_BASE,
  xApi: X_API_BASE,
  redditAuthorize: "https://www.reddit.com/api/v1/authorize",
  redditToken: REDDIT_TOKEN_URL,
  redditApi: REDDIT_API,
};

export interface ProviderDeps {
  fetch: typeof fetch;
  urls: Endpoints;
  now: () => Date;
}

/** The developer app's field values, e.g. {clientId, clientSecret}. */
export type AppKeys = Record<string, string>;

export interface StartResult {
  url: string;
  /** Server-side values the callback needs (PKCE verifier, X request-token secret); kept in the state row. */
  keep?: Record<string, string>;
  /** The state row's key when the provider doesn't echo ours (X: the request token). */
  stateKey?: string;
}

export interface Connected {
  /** Non-secret fields (ids from the sign-in, handle...). */
  data: Record<string, unknown>;
  secrets: Record<string, string>;
  /** Who it signed in as, for meta.account. */
  account: string;
  /** When the token stops working (Meta long-lived tokens). */
  expiresAt?: string;
}

export interface ProviderDef {
  provider: OAuthProvider;
  /** The developer-app fields the sign-in needs. */
  appKeys: readonly string[];
  /** The state key in the callback query. */
  stateOf(query: URLSearchParams): string | undefined;
  /** The provider's own refusal (the user pressed Cancel), as a short message. */
  errorOf(query: URLSearchParams): string | undefined;
  start(deps: ProviderDeps, args: { app: AppKeys; redirectUri: string; state: string }): Promise<StartResult>;
  finish(deps: ProviderDeps, args: { app: AppKeys; redirectUri: string; query: URLSearchParams; keep: Record<string, string> }): Promise<Connected>;
}

/** A sign-in failure whose message is safe to show (and to put in the redirect URL). */
export class OAuthFlowError extends Error {}

/** The standard OAuth 2.0 callback: `state`, and `error` / `error_description` on refusal. */
export const oauth2Callback = {
  stateOf: (q: URLSearchParams) => q.get("state") ?? undefined,
  errorOf: (q: URLSearchParams) => {
    const error = q.get("error");
    if (!error) return undefined;
    if (error === "access_denied") return "Access was not granted";
    return `The sign-in was refused (${error.slice(0, 60)})`;
  },
};

export function codeOf(query: URLSearchParams): string {
  const code = query.get("code");
  if (!code) throw new OAuthFlowError("The provider sent no authorization code");
  return code;
}

/** Reads a JSON body; a provider error becomes an OAuthFlowError naming the step (never echoing tokens). */
export async function jsonOf<T>(res: Response, step: string): Promise<T> {
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    // Meta user ids can exceed 2^53: keep long numeric ids as strings.
    body = JSON.parse(text.replace(/("(?:user_id|id)"\s*:\s*)(\d{16,})/g, '$1"$2"')) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const err = body.error as unknown;
    const why =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : typeof body.error_message === "string"
            ? body.error_message
            : `HTTP ${res.status}`;
    throw new OAuthFlowError(`${step} failed: ${why.slice(0, 120)}`);
  }
  return body as T;
}

export function postForm(deps: ProviderDeps, url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

export function expiresAtOf(deps: ProviderDeps, expiresIn: unknown, fallbackSeconds = 60 * 86400): string {
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : fallbackSeconds;
  return new Date(deps.now().getTime() + seconds * 1000).toISOString();
}
