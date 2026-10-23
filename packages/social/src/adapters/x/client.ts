import type { AdapterContext } from "../../types";
import { redact, toXApiError, XApiError } from "./errors";
import { authorizationHeader, type OAuth1Credentials } from "./oauth1";

export const X_API_BASE = "https://api.x.com";

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export type XBody = { json: unknown } | { multipart: FormData } | undefined;

/** A user-context (OAuth 1.0a) client for the few X v2 endpoints the adapter uses. */
export class XClient {
  private readonly oauth: OAuth1Credentials;
  readonly secrets: string[];

  constructor(
    creds: XCredentials,
    private readonly ctx: AdapterContext,
    private readonly baseUrl = X_API_BASE,
  ) {
    this.oauth = {
      consumerKey: creds.apiKey,
      consumerSecret: creds.apiSecret,
      token: creds.accessToken,
      tokenSecret: creds.accessTokenSecret,
    };
    this.secrets = [creds.apiKey, creds.apiSecret, creds.accessToken, creds.accessTokenSecret];
  }

  /** Calls `path` and returns the parsed JSON (or `{}` for an empty body). Throws `XApiError`. */
  async request<T>(method: string, path: string, what: string, body?: XBody, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      authorization: authorizationHeader({ method, url: url.toString() }, this.oauth, {
        timestamp: Math.floor(this.ctx.now().getTime() / 1000),
      }),
    };
    let payload: string | FormData | undefined;
    if (body && "json" in body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body && "multipart" in body) {
      payload = body.multipart; // fetch sets the multipart boundary itself
    }

    let res: Response;
    try {
      res = await this.ctx.fetch(url.toString(), { method, headers, body: payload, signal: this.ctx.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new XApiError(redact(`Couldn't reach X to ${what}: ${reason}`, this.secrets), 0);
    }
    if (!res.ok) throw await toXApiError(res, what, this.secrets, this.ctx.now());
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
