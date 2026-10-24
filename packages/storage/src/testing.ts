/**
 * An in-memory Google Drive + OAuth token endpoint behind a `fetch` function,
 * following the documented protocol closely enough to exercise the store.
 */
export class FakeDrive {
  files = new Map<string, { id: string; name: string; mimeType: string; parents: string[]; data: Buffer; appProperties: Record<string, string> }>();
  sessions = new Map<string, { meta: any; data: Buffer; total: number | null; done?: string }>();
  calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  tokensIssued = 0;
  /** Access tokens that are valid; others get 401. */
  valid = new Set<string>();
  /** Fail the next N chunk PUTs: "drop" (connection error), a status code, or "partial" (store half, reply 308). */
  failChunks: ("drop" | number | "partial")[] = [];
  /** The token endpoint answers this status (e.g. 400 invalid_grant). */
  tokenStatus = 200;
  private seq = 0;

  private nextId(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    this.calls.push({ method, url: url.toString(), headers });
    const body = init.body === undefined || init.body === null ? Buffer.alloc(0) : Buffer.from(init.body as any);

    if (url.host === "oauth2.googleapis.com") {
      if (this.tokenStatus !== 200) return json({ error: "invalid_grant", error_description: "Bad Request", refresh_token: "1//secret-refresh-token-abcdefghijk" }, this.tokenStatus);
      const token = `ya29.fake-${++this.tokensIssued}`;
      this.valid.add(token);
      return json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
    }

    if (url.pathname.startsWith("/upload/session/")) return this.chunk(url.pathname.split("/").pop()!, headers, body);

    const token = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    if (!token || !this.valid.has(token)) return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);

    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(body.toString());
      const sid = this.nextId("s");
      const len = headers["x-upload-content-length"];
      this.sessions.set(sid, { meta, data: Buffer.alloc(0), total: len ? Number(len) : null });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/session/${sid}?upload_id=SECRETUPLOADID` } });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(body.toString());
      const id = this.nextId("folder");
      this.files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? [], data: Buffer.alloc(0), appProperties: {} });
      return json({ id });
    }
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const name = /name = '([^']*)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const cc = /value='([^']+)'/.exec(q)?.[1];
      const found = [...this.files.values()].filter(
        (f) => (!name || f.name === name) && (!parent || f.parents.includes(parent)) && (!cc || f.appProperties.ccId === cc),
      );
      return json({ files: found.map((f) => ({ id: f.id, size: String(f.data.length) })) });
    }
    if (url.pathname === "/drive/v3/about") return json({ storageQuota: { limit: "16106127360", usage: "1000", usageInDrive: "600" } });
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const file = this.files.get(decodeURIComponent(m[1]!));
      if (!file) return json({ error: { code: 404, message: "File not found" } }, 404);
      if (method === "DELETE") {
        this.files.delete(file.id);
        return new Response(null, { status: 204 });
      }
      if (url.searchParams.get("alt") === "media") {
        const range = /bytes=(\d+)-(\d+)/.exec(headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2]), file.data.length - 1);
          return new Response(new Uint8Array(file.data.subarray(start, end + 1)), {
            status: 206,
            headers: { "content-range": `bytes ${start}-${end}/${file.data.length}` },
          });
        }
        return new Response(new Uint8Array(file.data), { status: 200 });
      }
    }
    return json({ error: "unhandled" }, 500);
  };

  private chunk(sid: string, headers: Record<string, string>, body: Buffer): Response {
    const s = this.sessions.get(sid);
    if (!s) return json({ error: "not found" }, 404);
    const range = (s.data.length ? { range: `bytes=0-${s.data.length - 1}` } : {}) as Record<string, string>;
    if (s.done) return json(this.resource(s.done), 200);
    const status = /^bytes \*\/(\d+|\*)$/.exec(headers["content-range"] ?? "");
    if (status) {
      if (status[1] !== "*" && Number(status[1]) === s.data.length) return this.finish(sid);
      return new Response(null, { status: 308, headers: range });
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(headers["content-range"] ?? "");
    if (!m) return json({ error: "bad range" }, 400);
    const fail = this.failChunks.shift();
    if (fail === "drop") throw new TypeError("fetch failed: socket hang up");
    if (typeof fail === "number") return json({ error: { message: "backend error" } }, fail);
    const start = Number(m[1]);
    if (start !== s.data.length) return new Response(null, { status: 308, headers: range });
    const keep = fail === "partial" ? body.subarray(0, Math.floor(body.length / 2)) : body;
    s.data = Buffer.concat([s.data, keep]);
    if (m[3] !== "*") s.total = Number(m[3]);
    if (s.total !== null && s.data.length === s.total) return this.finish(sid);
    return new Response(null, { status: 308, headers: { range: `bytes=0-${s.data.length - 1}` } });
  }

  private finish(sid: string): Response {
    const s = this.sessions.get(sid)!;
    const id = this.nextId("file");
    this.files.set(id, { id, name: s.meta.name, mimeType: s.meta.mimeType, parents: s.meta.parents, data: s.data, appProperties: s.meta.appProperties ?? {} });
    s.done = id;
    return json(this.resource(id), 200);
  }

  private resource(id: string) {
    const f = this.files.get(id)!;
    return { id, mimeType: f.mimeType, size: String(f.data.length) };
  }

  /** Chunk PUTs (with bytes) sent to upload sessions. */
  chunkPuts() {
    return this.calls.filter((c) => c.url.includes("/upload/session/") && !c.headers["content-range"]?.includes("*/"));
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
