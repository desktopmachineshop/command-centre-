import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * GET a public web page from the server without letting the URL reach anything private (SSRF).
 * - http(s) only, no credentials in the URL, web ports only.
 * - The host must resolve only to public addresses: loopback, private, link-local (cloud metadata
 *   at 169.254.169.254), CGNAT, multicast and reserved ranges are refused, for IPv4 and IPv6
 *   (including IPv4 mapped into IPv6).
 * - Redirects are followed by hand, each hop checked the same way.
 * - The default transport connects through a DNS lookup that applies the same check, so a host
 *   that resolves differently between the check and the connection (DNS rebinding) is refused too.
 * - The body is cut at `maxBytes` and the whole fetch at `timeoutMs`.
 * It never sends cookies or credentials, and says who it is in the User-Agent.
 */

export const RESEARCH_USER_AGENT = "CommandCentreResearch/1.0 (a small business owner's private research assistant; low volume)";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export class FetchFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchFailedError";
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127], // unspecified and loopback
  ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23], // Teredo and other protocol assignments
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4: an IPv4 address in disguise
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) blocked.addSubnet(net, bits, "ipv6");

/** True for an address the server must never fetch from: anything not plainly public. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family !== 6) return true; // not an address at all
  // IPv4 mapped or embedded in IPv6 (::ffff:10.0.0.1, ::ffff:a00:1, ::10.0.0.1): judge the IPv4 address.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? hexMapped(ip);
  if (mapped) return blocked.check(mapped, "ipv4");
  return blocked.check(ip, "ipv6");
}

function hexMapped(ip: string): string | null {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!m) return null;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const BLOCKED_HOSTS = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|example|onion)$/i;

/** Resolves a host name to every address it has. */
export type Lookup = (host: string) => Promise<string[]>;

export const systemLookup: Lookup = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses.map((a) => a.address))));
  });

/** The URL, parsed, if it is one the server may fetch by its shape alone (addresses are checked by `assertPublicUrl`). */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError(`"${raw.slice(0, 200)}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError(`Only http and https URLs can be fetched, not ${url.protocol}`);
  if (url.username || url.password) throw new UnsafeUrlError("URLs with a username or password are not fetched");
  if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError(`Port ${url.port} is not fetched (web ports only)`);
  const host = url.hostname.replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("The URL has no host");
  if (isIP(host.replace(/^\[|\]$/g, ""))) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(`${host} is a private or reserved address`);
  } else if (!host.includes(".") || BLOCKED_HOSTS.test(host)) {
    throw new UnsafeUrlError(`${host} is not a public host name`);
  }
  return url;
}

/** Throws unless the URL is public by shape and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string, lookup: Lookup = systemLookup): Promise<URL> {
  const url = parsePublicUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host)) return url;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new FetchFailedError(`${host} could not be found (DNS)`);
  }
  if (!addresses.length) throw new FetchFailedError(`${host} could not be found (DNS)`);
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError(`${host} resolves to a private or reserved address`);
  return url;
}

/** One request, no redirects followed: what a transport gives back. */
export interface Hop {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
}
export type Transport = (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Hop>;

/**
 * The default transport: node's http(s) with a DNS lookup that refuses private addresses at
 * connect time. `isBlocked` is the address check (tests replace it to reach a local server).
 */
export const createPinnedTransport =
  (isBlocked: (address: string) => boolean = isPrivateAddress): Transport =>
  (url, init) =>
  new Promise<Hop>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        headers: { ...init.headers, "accept-encoding": "gzip, deflate, br" },
        signal: init.signal,
        lookup: (hostname, options, callback) => {
          const all = typeof options === "object" && options.all === true;
          dnsLookup(hostname, { ...(typeof options === "object" ? options : {}), all: true }, (err, addresses) => {
            const cb = callback as (e: Error | null, address?: unknown, family?: number) => void;
            if (err) return cb(err);
            const list = addresses as unknown as { address: string; family: number }[];
            if (!list.length || list.some((a) => isBlocked(a.address))) {
              return cb(new UnsafeUrlError(`${hostname} resolves to a private or reserved address`));
            }
            if (all) return cb(null, list);
            cb(null, list[0]!.address, list[0]!.family);
          });
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        const encoding = (res.headers["content-encoding"] ?? "").toLowerCase();
        const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
        let body: Readable = res;
        if (decoder) {
          res.on("error", (e) => decoder.destroy(e));
          body = res.pipe(decoder);
        }
        resolve({ status: res.statusCode ?? 0, headers, body });
      },
    );
    req.on("error", reject);
    req.end();
  });

export const pinnedTransport: Transport = createPinnedTransport();

/** A transport over a `fetch` (tests inject one). */
export function fetchTransport(f: typeof fetch): Transport {
  return async (url, init) => {
    const res = await f(url.toString(), { method: "GET", headers: init.headers, signal: init.signal, redirect: "manual" });
    return { status: res.status, headers: res.headers, body: res.body as unknown as AsyncIterable<Uint8Array> | null };
  };
}

export interface SafeFetchOptions {
  transport?: Transport;
  lookup?: Lookup;
  /** Bytes of (decoded) body kept. Default 2 MB. */
  maxBytes?: number;
  /** For the whole fetch, redirects included. Default 20 s. */
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  /** The URL the content came from, after redirects. */
  url: string;
  status: number;
  contentType: string;
  text: string;
  bytes: number;
  /** The body was longer than `maxBytes` and was cut. */
  truncated: boolean;
  redirects: string[];
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|[a-z0-9.-]+\+json|[a-z0-9.-]+\+xml)$)/i;

/**
 * GET `raw` safely (see the top of this file). Returns the text of a text-like response, any
 * status: the caller decides what a 404 means. Throws UnsafeUrlError for a URL it won't fetch and
 * FetchFailedError for a network failure, too many redirects or a response that isn't text.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const transport = options.transport ?? pinnedTransport;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers = {
    "user-agent": options.userAgent ?? RESEARCH_USER_AGENT,
    accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,application/xml;q=0.8,text/plain;q=0.7,*/*;q=0.1",
    "accept-language": "en-GB,en;q=0.8",
  };
  const redirects: string[] = [];
  let current = raw;
  try {
    for (;;) {
      const url = await assertPublicUrl(current, options.lookup);
      url.hash = "";
      const hop = await transport(url, { headers, signal });
      if ([301, 302, 303, 307, 308].includes(hop.status)) {
        const location = hop.headers.get("location");
        await drain(hop.body);
        if (!location) throw new FetchFailedError(`${url.host} redirected without saying where`, hop.status);
        if (redirects.length >= maxRedirects) throw new FetchFailedError(`Too many redirects from ${raw}`);
        current = new URL(location, url).toString();
        redirects.push(current);
        continue;
      }
      const contentType = (hop.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (contentType && !TEXT_TYPES.test(contentType)) {
        await drain(hop.body);
        throw new FetchFailedError(`${url.toString()} is ${contentType}, not a page of text`, hop.status);
      }
      const { buffer, truncated } = await readCapped(hop.body, maxBytes);
      const charset = /charset=["']?([\w-]+)/i.exec(hop.headers.get("content-type") ?? "")?.[1];
      return { url: url.toString(), status: hop.status, contentType, text: decode(buffer, charset), bytes: buffer.length, truncated, redirects };
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError || err instanceof FetchFailedError) throw err;
    // A refusal from the pinned lookup may arrive wrapped as the request's error.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof UnsafeUrlError) throw cause;
    if (timeout.aborted) throw new FetchFailedError(`${hostOf(current)} took too long to answer`);
    throw new FetchFailedError(`${hostOf(current)} could not be fetched: ${(err as Error).message}`);
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "the page";
  }
};

async function drain(body: Hop["body"]): Promise<void> {
  if (!body) return;
  const stream = body as unknown as { destroy?: () => void; cancel?: () => Promise<void> };
  if (typeof stream.destroy === "function") stream.destroy();
  // Not awaited: cancelling one half of a tee'd (cloned) body only settles when the other half ends.
  else void stream.cancel?.().catch(() => {});
}

async function readCapped(body: Hop["body"], maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!body) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    const b = Buffer.from(chunk);
    if (size + b.length > maxBytes) {
      chunks.push(b.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(b);
    size += b.length;
  }
  if (truncated) await drain(body);
  return { buffer: Buffer.concat(chunks), truncated };
}

function decode(buffer: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}
