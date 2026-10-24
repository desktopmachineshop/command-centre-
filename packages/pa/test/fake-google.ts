/** A recorded-shape fake of Google's token and Calendar endpoints, as an injected fetch. */
export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => { status?: number; json?: unknown } | undefined;

export class FakeGoogle {
  readonly calls: Call[] = [];
  tokenCount = 0;
  /** Token responses, in order (the last repeats). */
  tokenResponses: { status?: number; json: unknown }[] = [{ json: { access_token: "at-1", expires_in: 3599, token_type: "Bearer" } }];
  /** Access tokens the API accepts. */
  valid = new Set(["at-1", "at-2"]);
  private readonly routes: { method: string; path: RegExp; handler: Handler }[] = [];

  route(method: string, path: RegExp, handler: Handler) {
    this.routes.push({ method, path, handler });
    return this;
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const raw = init.body ? String(init.body) : "";
    const body = headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw ? Object.fromEntries(new URLSearchParams(raw)) : undefined;
    const call: Call = { method: init.method ?? "GET", url, headers, body };
    this.calls.push(call);
    const reply = (status: number, json?: unknown) =>
      new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

    if (url.href === "https://oauth2.googleapis.com/token") {
      const r = this.tokenResponses[Math.min(this.tokenCount++, this.tokenResponses.length - 1)]!;
      return reply(r.status ?? 200, r.json);
    }
    if (!this.valid.has(headers.authorization?.replace("Bearer ", "") ?? "")) {
      return reply(401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });
    }
    for (const r of this.routes) {
      if (r.method === call.method && r.path.test(url.pathname)) {
        const out = r.handler(call);
        if (out) return reply(out.status ?? 200, out.json);
      }
    }
    return reply(404, { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } });
  };

  apiCalls() {
    return this.calls.filter((c) => c.url.hostname === "www.googleapis.com");
  }
}
