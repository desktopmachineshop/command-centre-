import { fetchTransport, type Lookup, type SafeFetchOptions } from "../src";

/** An in-memory web: `"host/path"` -> a body, a `Response` (served once; use a function to serve it again), or a function of the URL. Unknown paths are 404. */
export type Routes = Record<string, string | object | Response | ((url: URL) => Response | string | object)>;

export function fakeWeb(routes: Routes, dns: Record<string, string[]> = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const respond = (value: string | object | Response): Response => {
    if (value instanceof Response) return value;
    if (typeof value === "string") {
      const type = value.trimStart().startsWith("<?xml") || value.trimStart().startsWith("<urlset") || value.trimStart().startsWith("<sitemapindex") ? "application/xml" : value.includes("<") ? "text/html; charset=utf-8" : "text/plain";
      return new Response(value, { status: 200, headers: { "content-type": type } });
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[`${url.host}${url.pathname}${url.search}`] ?? routes[`${url.host}${url.pathname}`];
    if (route === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return respond(typeof route === "function" ? route(url) : route);
  }) as typeof globalThis.fetch;
  // Every host is public unless `dns` says otherwise.
  const lookup: Lookup = async (host) => dns[host] ?? ["93.184.216.34"];
  const options: SafeFetchOptions = { transport: fetchTransport(fetch), lookup };
  return { fetch, lookup, options, requests };
}

export const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
