import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a request signing (HMAC-SHA1), as X documents it in "Creating a signature"
 * (https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature).
 *
 * Only the OAuth params, the query string and `application/x-www-form-urlencoded` body params are
 * signed. JSON and multipart bodies are not part of the signature (RFC 5849 §3.4.1.3).
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export interface OAuth1Request {
  method: string;
  /** Full URL; any query string is included in the signature. */
  url: string;
  /** Form-encoded body params (signed). Leave out for JSON or multipart bodies. */
  bodyParams?: Record<string, string>;
}

/** RFC 3986 percent-encoding: everything except the unreserved characters A-Z a-z 0-9 - . _ ~ */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Base URL for the signature: scheme and host lowercased, default port dropped, no query or fragment. */
function baseUrl(url: URL): string {
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}`;
}

export function signatureBaseString(req: OAuth1Request, oauthParams: Record<string, string>): string {
  const url = new URL(req.url);
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([percentEncode(k), percentEncode(v)]);
  for (const [k, v] of Object.entries(req.bodyParams ?? {})) pairs.push([percentEncode(k), percentEncode(v)]);
  for (const [k, v] of Object.entries(oauthParams)) pairs.push([percentEncode(k), percentEncode(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  return [req.method.toUpperCase(), percentEncode(baseUrl(url)), percentEncode(paramString)].join("&");
}

export function sign(baseString: string, consumerSecret: string, tokenSecret: string): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString).digest("base64");
}

/** Builds the `Authorization: OAuth ...` header value. `nonce` and `timestamp` are injectable for tests. */
export function authorizationHeader(
  req: OAuth1Request,
  creds: OAuth1Credentials,
  opts: { nonce?: string; timestamp?: number } = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const all: Record<string, string> = {
    ...oauth,
    oauth_signature: sign(signatureBaseString(req, oauth), creds.consumerSecret, creds.tokenSecret),
  };
  return (
    "OAuth " +
    Object.keys(all)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(all[k]!)}"`)
      .join(", ")
  );
}
