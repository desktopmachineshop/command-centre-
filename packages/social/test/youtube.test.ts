import { describe, expect, it, vi } from "vitest";
import { adapters, type AdapterContext, type PostContent, type SocialAccount } from "../src";
import { buildDescription, createYouTubeAdapter, tagsLength, YouTubeApiError } from "../src/adapters/youtube";
import { redact } from "../src/adapters/youtube/client";
import { buildAuthUrl, createPkce, exchangeCode } from "../src/adapters/youtube/oauth";

const CLIENT_SECRET = "GOCSPX-client-SECRET-123";
const REFRESH = "1//refresh-TOKEN-abcdefghijklmnop";
const ACCESS = "ya29.access-TOKEN-1";
const ACCESS2 = "ya29.access-TOKEN-2";
const CHANNEL = "UC1234567890abcdefghijkl";
const KiB = 1024;
const CHUNK = 256 * KiB;

const account = (options: Record<string, unknown> = {}): SocialAccount => ({
  id: "3dp-youtube",
  platform: "youtube",
  vertical: "3dpandme",
  handle: "@3dpandme",
  inbound: true,
  credentials: { clientId: "123-abc.apps.googleusercontent.com", clientSecret: CLIENT_SECRET, refreshToken: REFRESH, channelId: CHANNEL },
  options,
});

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  text: string;
  bytes: Uint8Array;
}

type Handler = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const tokenOk = (token = ACCESS) => json({ access_token: token, expires_in: 3599, token_type: "Bearer", scope: "https://www.googleapis.com/auth/youtube.upload" });

/** Routes "METHOD origin+path" to handlers; token refreshes are answered unless overridden. */
function mock(routes: Record<string, Handler>, opts: { token?: Handler } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = init?.body;
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : "");
    const call: Call = { method: init?.method ?? "GET", url, headers, text: new TextDecoder().decode(bytes), bytes: new Uint8Array(bytes) };
    calls.push(call);
    const key = `${call.method} ${url.origin}${url.pathname}`;
    if (key === "POST https://oauth2.googleapis.com/token") return (opts.token ?? (() => tokenOk()))(call);
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    return route(call);
  });
  const clock = { t: Date.parse("2026-10-23T12:00:00Z") };
  const ctx: AdapterContext = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => new Date(clock.t),
    log: {
      info: (m) => logs.push(`info: ${m}`),
      error: (m, e) => logs.push(`error: ${m}${e instanceof Error ? ` ${e.message}` : ""}`),
    },
  };
  return { ctx, calls, logs, clock, of: (key: string) => calls.filter((c) => `${c.method} ${c.url.origin}${c.url.pathname}` === key) };
}

const noSleep = async () => {};
const adapterFor = () => createYouTubeAdapter({ chunkBytes: CHUNK, sleep: noSleep });

/** A video file served in uneven pieces, optionally without a Content-Length. */
function videoBytes(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 7 + 3) % 251;
  return b;
}
function serveVideo(bytes: Uint8Array, withLength = true): Handler {
  return () => {
    let off = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (off >= bytes.byteLength) return ctrl.close();
        const n = 100 * KiB + 13;
        ctrl.enqueue(bytes.slice(off, off + n));
        off += n;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "video/mp4", ...(withLength ? { "content-length": String(bytes.byteLength) } : {}) } });
  };
}

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION-ID-xyz";
const UPLOAD_INIT = "POST https://www.googleapis.com/upload/youtube/v3/videos";
const UPLOAD_PUT = "PUT https://www.googleapis.com/upload/youtube/v3/videos";

/** A fake resumable-upload server that stores what it receives. */
function uploadServer(opts: { total?: number; video?: Record<string, unknown>; misbehave?: (n: number, call: Call) => Response | undefined } = {}) {
  const received: number[] = [];
  let puts = 0;
  const store = {
    parts: [] as Uint8Array[],
    get length() {
      return this.parts.reduce((n, p) => n + p.byteLength, 0);
    },
    push(b: Uint8Array) {
      this.parts.push(new Uint8Array(b));
    },
    all() {
      return new Uint8Array(Buffer.concat(this.parts));
    },
  };
  const init: Handler = () => new Response(null, { status: 200, headers: { location: SESSION } });
  const put: Handler = (call) => {
    puts++;
    const bad = opts.misbehave?.(puts, call);
    if (bad) return bad;
    const range = call.headers["content-range"]!;
    const status = /^bytes \*\/(\d+|\*)$/.exec(range);
    if (status) {
      const total = status[1] === "*" ? undefined : Number(status[1]);
      if (total !== undefined && store.length === total) return json({ id: "vid123", status: { uploadStatus: "uploaded", privacyStatus: "private" }, ...opts.video }, 201);
      return new Response(null, { status: 308, headers: store.length ? { range: `bytes=0-${store.length - 1}` } : {} });
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range)!;
    const first = Number(m[1]);
    expect(first).toBe(store.length);
    expect(Number(m[2]) - first + 1).toBe(call.bytes.byteLength);
    store.push(call.bytes);
    received.push(call.bytes.byteLength);
    if (m[3] !== "*" && store.length === Number(m[3])) {
      return json({ id: "vid123", status: { uploadStatus: "uploaded", privacyStatus: "private" }, ...opts.video }, 201);
    }
    return new Response(null, { status: 308, headers: { range: `bytes=0-${store.length - 1}` } });
  };
  return { init, put, received, store };
}

const post = (extra: Partial<PostContent> = {}): PostContent => ({
  title: "ER11 collet guide",
  text: "How to pick and fit ER11 collets.\n\n00:00 Intro\n01:10 Sizes",
  link: "https://3dpandme.com/er11",
  media: [{ url: "https://cc.example/media/abc.mp4", type: "video" }],
  ...extra,
});

describe("youtube contract", () => {
  it("is registered and declares its capabilities", () => {
    expect(adapters.youtube.platform).toBe("youtube");
    expect(adapters.youtube.capabilities).toMatchObject({ publish: true, reply: true, dm: false, inbound: true, media: ["video"], requiresMedia: true, requiresTitle: true });
    expect(adapters.youtube.inbound?.pollIntervalSeconds).toBe(900);
    expect(createYouTubeAdapter({ pollIntervalSeconds: 1800 }).inbound?.pollIntervalSeconds).toBe(1800);
  });

  it("checks credentials", () => {
    const bad = adapters.youtube.credentials.safeParse({ clientId: "x", clientSecret: "y", refreshToken: "z", channelId: "not-a-channel" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("starting with UC");
    expect(adapters.youtube.credentials.safeParse(account().credentials).success).toBe(true);
  });
});

describe("youtube validate", () => {
  const v = (content: PostContent) => adapterFor().validate(account(), content);

  it("accepts a normal upload", () => {
    expect(v(post({ options: { privacyStatus: "private", publishAt: "2026-10-24T18:00:00+01:00", tags: ["3d printing", "cnc"], categoryId: "28", madeForKids: false, thumbnailUrl: "https://cc.example/media/t.jpg" } }))).toEqual([]);
  });

  it("requires a title of at most 100 characters without < or >", () => {
    expect(v(post({ title: undefined }))).toContain("a title is required");
    expect(v(post({ title: "x".repeat(101) }))).toContain("title is longer than 100 characters");
    expect(v(post({ title: "x".repeat(100) }))).toEqual([]);
    expect(v(post({ title: "Best <3 tips" }))).toContain("title can't contain < or >");
  });

  it("requires exactly one video", () => {
    expect(v(post({ media: [] }))).toContain("at least one image or video is required");
    expect(v(post({ media: undefined, text: "" }))).toContain("at least one image or video is required");
    expect(v(post({ media: [{ url: "https://cc.example/a.jpg", type: "image" }] }))).toContain("image media is not supported");
    expect(v(post({ media: [post().media![0]!, post().media![0]!] }))).toContain("a YouTube post is one video");
  });

  it("counts the description (text plus link) in bytes", () => {
    expect(v(post({ text: "€".repeat(1700), link: undefined }))).toContain("description (text plus link) is longer than 5000 bytes");
    expect(v(post({ text: "a".repeat(4990), link: "https://3dpandme.com/er11" }))).toContain("description (text plus link) is longer than 5000 bytes");
    expect(v(post({ text: "a".repeat(4900) }))).toEqual([]);
  });

  it("checks options", () => {
    expect(v(post({ options: { publishAt: "2026-10-24T18:00:00Z", privacyStatus: "public" } }))).toContain(
      'options.publishAt needs privacyStatus "private" (YouTube makes it public at that time)',
    );
    expect(v(post({ options: { privacyStatus: "secret" } })).join()).toContain("options.privacyStatus");
    expect(v(post({ options: { tags: Array.from({ length: 60 }, (_, i) => `tag number ${i}`) } }))).toContain("tags are longer than 500 characters in all");
    expect(v(post({ options: { thumbnailUrl: "ftp://x" } })).join()).toContain("thumbnailUrl");
    expect(v(post({ target: "somewhere" }))).toContain("YouTube doesn't use a target");
  });

  it("builds the description and counts tags like YouTube", () => {
    expect(buildDescription({ text: "Hi", link: "https://a.b" })).toBe("Hi\n\nhttps://a.b");
    expect(buildDescription({ text: "See https://a.b", link: "https://a.b" })).toBe("See https://a.b");
    expect(tagsLength(["Foo-Baz"])).toBe(7);
    expect(tagsLength(["Foo Baz"])).toBe(9);
    expect(tagsLength(["a", "b"])).toBe(3);
  });
});

describe("youtube auth", () => {
  it("exchanges the refresh token, caches the access token and refreshes it before expiry", async () => {
    const m = mock({ "POST https://www.googleapis.com/youtube/v3/comments": () => json({ id: "Ugz.r1", snippet: { videoId: "vid1" } }) });
    const yt = adapterFor();
    const target = { platform: "youtube" as const, kind: "comment" as const, id: "Ugz", threadId: "Ugz", videoId: "vid1" };
    await yt.reply(account(), target, "Thanks!", m.ctx);
    await yt.reply(account(), target, "Thanks again!", m.ctx);
    const grants = m.of("POST https://oauth2.googleapis.com/token");
    expect(grants).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(grants[0]!.text))).toEqual({
      client_id: "123-abc.apps.googleusercontent.com",
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH,
      grant_type: "refresh_token",
    });
    expect(m.of("POST https://www.googleapis.com/youtube/v3/comments")[0]!.headers.authorization).toBe(`Bearer ${ACCESS}`);

    m.clock.t += 56 * 60_000; // inside the 5-minute early-refresh window
    await yt.reply(account(), target, "Third", m.ctx);
    expect(m.of("POST https://oauth2.googleapis.com/token")).toHaveLength(2);
  });

  it("refreshes once after a 401", async () => {
    let n = 0;
    const m = mock(
      {
        "POST https://www.googleapis.com/youtube/v3/comments": (c) =>
          c.headers.authorization === `Bearer ${ACCESS}` ? json({ error: { code: 401, message: "Invalid Credentials" } }, 401) : json({ id: "r2" }),
      },
      { token: () => tokenOk(n++ === 0 ? ACCESS : ACCESS2) },
    );
    const res = await adapterFor().reply(account(), { platform: "youtube", kind: "comment", id: "Ugz" }, "Hi", m.ctx);
    expect(res.id).toBe("r2");
    expect(m.of("POST https://oauth2.googleapis.com/token")).toHaveLength(2);
  });

  it("explains a revoked or expired refresh token without leaking it", async () => {
    const m = mock({}, { token: () => json({ error: "invalid_grant", error_description: `Token has been expired or revoked: ${REFRESH}` }, 400) });
    const err = (await adapterFor()
      .reply(account(), { platform: "youtube", kind: "comment", id: "Ugz" }, "Hi", m.ctx)
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(YouTubeApiError);
    expect(err.message).toContain("invalid_grant");
    expect(err.message).toContain("youtube:auth");
    expect(err.message).toContain("7 days");
    for (const s of [CLIENT_SECRET, REFRESH]) expect(err.message).not.toContain(s);
  });
});

describe("youtube publish", () => {
  it("uploads with the resumable protocol, streaming chunk by chunk", async () => {
    const bytes = videoBytes(2 * CHUNK + 90 * KiB);
    const up = uploadServer();
    const m = mock({ "GET https://cc.example/media/abc.mp4": serveVideo(bytes), [UPLOAD_INIT]: up.init, [UPLOAD_PUT]: up.put });
    const res = await adapterFor().publish(account({ defaultCategoryId: "28" }), post({ options: { tags: ["er11", "cnc"] } }), m.ctx);
    expect(res).toEqual({ id: "vid123", url: "https://youtu.be/vid123" });

    const init = m.of(UPLOAD_INIT)[0]!;
    expect(Object.fromEntries(init.url.searchParams)).toEqual({ uploadType: "resumable", part: "snippet,status" });
    expect(init.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(init.headers["x-upload-content-type"]).toBe("video/mp4");
    expect(init.headers["x-upload-content-length"]).toBe(String(bytes.byteLength));
    expect(JSON.parse(init.text)).toEqual({
      snippet: {
        title: "ER11 collet guide",
        description: "How to pick and fit ER11 collets.\n\n00:00 Intro\n01:10 Sizes\n\nhttps://3dpandme.com/er11",
        tags: ["er11", "cnc"],
        categoryId: "28",
      },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    });

    const puts = m.of(UPLOAD_PUT);
    expect(puts.map((p) => p.headers["content-range"])).toEqual([
      `bytes 0-${CHUNK - 1}/${bytes.byteLength}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${bytes.byteLength}`,
      `bytes ${2 * CHUNK}-${bytes.byteLength - 1}/${bytes.byteLength}`,
    ]);
    expect(puts.every((p) => p.url.toString() === SESSION && p.headers.authorization === `Bearer ${ACCESS}`)).toBe(true);
    expect(Buffer.compare(up.store.all(), bytes)).toBe(0);
  });

  it("schedules with publishAt and passes YouTube's options through", async () => {
    const up = uploadServer();
    const m = mock({ "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(1000)), [UPLOAD_INIT]: up.init, [UPLOAD_PUT]: up.put });
    await adapterFor().publish(
      account(),
      post({ link: undefined, options: { publishAt: "2026-10-24T18:00:00+01:00", madeForKids: true, notifySubscribers: false, containsSyntheticMedia: false, categoryId: 26 } }),
      m.ctx,
    );
    const init = m.of(UPLOAD_INIT)[0]!;
    expect(init.url.searchParams.get("notifySubscribers")).toBe("false");
    const body = JSON.parse(init.text);
    expect(body.status).toEqual({ privacyStatus: "private", publishAt: "2026-10-24T17:00:00.000Z", selfDeclaredMadeForKids: true, containsSyntheticMedia: false });
    expect(body.snippet.categoryId).toBe("26");
  });

  it("resumes after a partial chunk and after a 503", async () => {
    const bytes = videoBytes(2 * CHUNK + 5000);
    let partialDone = false;
    const up = uploadServer({
      misbehave: (n, call) => {
        if (n === 1 && !partialDone) {
          // Accept only the first 100 KiB of the first chunk.
          partialDone = true;
          up.store.push(call.bytes.subarray(0, 100 * KiB));
          return new Response(null, { status: 308, headers: { range: `bytes=0-${100 * KiB - 1}` } });
        }
        if (n === 2) return json({ error: { code: 503, message: "Backend Error" } }, 503);
        return undefined;
      },
    });
    const m = mock({ "GET https://cc.example/media/abc.mp4": serveVideo(bytes), [UPLOAD_INIT]: up.init, [UPLOAD_PUT]: up.put });
    const res = await adapterFor().publish(account(), post(), m.ctx);
    expect(res.id).toBe("vid123");
    const ranges = m.of(UPLOAD_PUT).map((p) => p.headers["content-range"]);
    expect(ranges).toEqual([
      `bytes 0-${CHUNK - 1}/${bytes.byteLength}`,
      `bytes ${100 * KiB}-${100 * KiB + CHUNK - 1}/${bytes.byteLength}`, // 503
      `bytes */${bytes.byteLength}`, // status check
      `bytes ${100 * KiB}-${100 * KiB + CHUNK - 1}/${bytes.byteLength}`,
      `bytes ${100 * KiB + CHUNK}-${bytes.byteLength - 1}/${bytes.byteLength}`,
    ]);
    expect(Buffer.compare(up.store.all(), bytes)).toBe(0);
  });

  it("streams a video of unknown length, giving the total with the last chunk", async () => {
    const bytes = videoBytes(2 * CHUNK); // an exact multiple: the end is announced with an empty PUT
    const up = uploadServer();
    const m = mock({ "GET https://cc.example/media/abc.mp4": serveVideo(bytes, false), [UPLOAD_INIT]: up.init, [UPLOAD_PUT]: up.put });
    await adapterFor().publish(account(), post(), m.ctx);
    expect(m.of(UPLOAD_INIT)[0]!.headers["x-upload-content-length"]).toBeUndefined();
    expect(m.of(UPLOAD_PUT).map((p) => p.headers["content-range"])).toEqual([
      `bytes 0-${CHUNK - 1}/*`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/*`,
      `bytes */${2 * CHUNK}`,
    ]);
    expect(Buffer.compare(up.store.all(), bytes)).toBe(0);
  });

  it("sets the thumbnail after the upload", async () => {
    const up = uploadServer();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const m = mock({
      "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(1000)),
      [UPLOAD_INIT]: up.init,
      [UPLOAD_PUT]: up.put,
      "GET https://cc.example/media/thumb.png": () => new Response(png, { headers: { "content-type": "image/png" } }),
      "POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set": () => json({ items: [{ default: { url: "https://i.ytimg.com/x.jpg" } }] }),
    });
    const res = await adapterFor().publish(account(), post({ options: { thumbnailUrl: "https://cc.example/media/thumb.png" } }), m.ctx);
    expect(res.url).toBe("https://youtu.be/vid123");
    const set = m.of("POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set")[0]!;
    expect(Object.fromEntries(set.url.searchParams)).toEqual({ videoId: "vid123", uploadType: "media" });
    expect(set.headers["content-type"]).toBe("image/png");
    expect(set.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(set.bytes).toEqual(png);
    expect(m.logs.filter((l) => l.startsWith("error"))).toEqual([]);
  });

  it("keeps the upload when the thumbnail fails, and logs why", async () => {
    const up = uploadServer();
    const m = mock({
      "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(1000)),
      [UPLOAD_INIT]: up.init,
      [UPLOAD_PUT]: up.put,
      "GET https://cc.example/media/thumb.jpg": () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } }),
      "POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set": () =>
        json({ error: { code: 403, message: "The authenticated user doesnt have permissions to upload and set custom video thumbnails.", errors: [{ reason: "forbidden" }] } }, 403),
    });
    const res = await adapterFor().publish(account(), post({ options: { thumbnailUrl: "https://cc.example/media/thumb.jpg" } }), m.ctx);
    expect(res.id).toBe("vid123");
    expect(m.logs.join("\n")).toMatch(/setting the thumbnail failed.*verified channel/);
  });

  it("warns when YouTube locks a public upload as private", async () => {
    const up = uploadServer();
    const m = mock({ "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(10)), [UPLOAD_INIT]: up.init, [UPLOAD_PUT]: up.put });
    await adapterFor().publish(account(), post({ options: { privacyStatus: "public" } }), m.ctx);
    expect(JSON.parse(m.of(UPLOAD_INIT)[0]!.text).status.privacyStatus).toBe("public");
    expect(m.logs.join("\n")).toContain("made it private");
  });

  it("maps quotaExceeded to a clear error", async () => {
    const m = mock({
      "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(10)),
      [UPLOAD_INIT]: () =>
        json(
          {
            error: {
              code: 403,
              message: "The request cannot be completed because you have exceeded your <a href=\"/youtube/v3/getting-started#quota\">quota</a>.",
              errors: [{ message: "quota", domain: "youtube.quota", reason: "quotaExceeded" }],
            },
          },
          403,
        ),
    });
    const err = (await adapterFor()
      .publish(account(), post(), m.ctx)
      .catch((e: unknown) => e)) as YouTubeApiError;
    expect(err).toBeInstanceOf(YouTubeApiError);
    expect(err.kind).toBe("quota");
    expect(err.reason).toBe("quotaExceeded");
    expect(err.status).toBe(403);
    expect(err.message).toContain("daily quota");
    expect(err.message).toContain("midnight Pacific");
    expect(m.of(UPLOAD_PUT)).toHaveLength(0);
  });

  it("maps the channel upload limit and a rejected upload", async () => {
    const m = mock({
      "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(10)),
      [UPLOAD_INIT]: () => json({ error: { code: 400, message: "limit", errors: [{ reason: "uploadLimitExceeded" }] } }, 400),
    });
    const err = (await adapterFor().publish(account(), post(), m.ctx).catch((e: unknown) => e)) as YouTubeApiError;
    expect(err.kind).toBe("quota");
    expect(err.message).toContain("upload limit");

    const up = uploadServer({ video: { status: { uploadStatus: "rejected", rejectionReason: "duplicate" } } });
    const m2 = mock({ "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(10)), [UPLOAD_INIT]: up.init, [UPLOAD_PUT]: up.put });
    const err2 = (await adapterFor().publish(account(), post(), m2.ctx).catch((e: unknown) => e)) as Error;
    expect(err2.message).toContain("rejected the upload (duplicate)");
  });

  it("refuses invalid content before touching the network", async () => {
    const m = mock({});
    await expect(adapterFor().publish(account(), post({ title: "" }), m.ctx)).rejects.toThrow("a title is required");
    expect(m.calls).toHaveLength(0);
  });
});

describe("youtube redaction", () => {
  it("never shows tokens or secrets, even when an error echoes them", async () => {
    const m = mock({
      "GET https://cc.example/media/abc.mp4": serveVideo(videoBytes(10)),
      [UPLOAD_INIT]: (c) =>
        json({ error: { code: 400, message: `bad header ${c.headers.authorization} for ${REFRESH} / ${encodeURIComponent(CLIENT_SECRET)} at ${SESSION}` } }, 400),
    });
    const err = (await adapterFor().publish(account(), post(), m.ctx).catch((e: unknown) => e)) as Error;
    for (const s of [ACCESS, REFRESH, CLIENT_SECRET, encodeURIComponent(CLIENT_SECRET), "SESSION-ID-xyz"]) expect(err.message).not.toContain(s);
    expect(err.message).toContain("[redacted]");
  });

  it("scrubs Google token shapes and bearer headers", () => {
    expect(redact("Authorization: Bearer abc.def-123 and ya29.zzz and 1//0gABCDEFGHIJKLMNOP", [])).toBe(
      "Authorization: Bearer [redacted] and [redacted] and [redacted]",
    );
    expect(redact(`x ${SESSION}`, [])).toContain("upload_id=[redacted]");
  });
});

describe("youtube reply", () => {
  it("replies on the thread with comments.insert, mentioning the author of a reply", async () => {
    const m = mock({ "POST https://www.googleapis.com/youtube/v3/comments": () => json({ id: "UgzTOP.reply9", snippet: { videoId: "vid1" } }) });
    const res = await adapterFor().reply(
      account(),
      { platform: "youtube", kind: "reply", id: "UgzTOP.reply1", threadId: "UgzTOP", videoId: "vid1", mention: "jane" },
      "Yes, 0.4 mm nozzle.",
      m.ctx,
    );
    const call = m.of("POST https://www.googleapis.com/youtube/v3/comments")[0]!;
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ part: "snippet" });
    expect(call.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(call.text)).toEqual({ snippet: { parentId: "UgzTOP", textOriginal: "@jane Yes, 0.4 mm nozzle." } });
    expect(res).toEqual({ id: "UgzTOP.reply9", url: "https://www.youtube.com/watch?v=vid1&lc=UgzTOP.reply9" });
  });

  it("derives the thread from a reply id and explains disabled comments", async () => {
    const m = mock({
      "POST https://www.googleapis.com/youtube/v3/comments": () =>
        json({ error: { code: 403, message: "The video identified by the videoId parameter has disabled comments.", errors: [{ reason: "commentsDisabled" }] } }, 403),
    });
    const err = (await adapterFor()
      .reply(account(), { platform: "youtube", kind: "reply", id: "UgzTOP.reply1" }, "Hi", m.ctx)
      .catch((e: unknown) => e)) as YouTubeApiError;
    expect(JSON.parse(m.calls.at(-1)!.text).snippet.parentId).toBe("UgzTOP");
    expect(err.reason).toBe("commentsDisabled");
    expect(err.message).toContain("comments are turned off");
  });
});

describe("youtube inbound", () => {
  const comment = (id: string, at: string, text: string, author = "@jane", authorId = "UCjane", videoId = "vid1", parentId?: string) => ({
    id,
    snippet: {
      videoId,
      textDisplay: text,
      textOriginal: text,
      authorDisplayName: author,
      authorChannelUrl: `http://www.youtube.com/${author}`,
      authorChannelId: { value: authorId },
      publishedAt: at,
      updatedAt: at,
      ...(parentId ? { parentId } : {}),
    },
  });
  const thread = (top: ReturnType<typeof comment>, replies: ReturnType<typeof comment>[] = [], total = replies.length) => ({
    id: top.id,
    snippet: { channelId: CHANNEL, videoId: top.snippet.videoId, topLevelComment: top, totalReplyCount: total, canReply: true },
    ...(replies.length ? { replies: { comments: replies } } : {}),
  });

  it("starts from now without backlog, then returns new comments and replies, skipping our own", async () => {
    const old = thread(comment("UgOLD", "2026-10-20T09:00:00Z", "Old comment"), [comment("UgOLD.r1", "2026-10-20T10:00:00Z", "old reply", "@bob", "UCbob", "vid1", "UgOLD")]);
    const justBefore = thread(comment("UgPREV", "2026-10-23T11:55:00Z", "Posted just before the first run"));
    let threads: unknown[] = [justBefore, old];
    let listed = 0;
    const m = mock({
      "GET https://www.googleapis.com/youtube/v3/commentThreads": (c) => {
        listed++;
        expect(Object.fromEntries(c.url.searchParams)).toEqual({
          part: "snippet,replies",
          allThreadsRelatedToChannelId: CHANNEL,
          order: "time",
          maxResults: "100",
          textFormat: "plainText",
        });
        return json({ items: threads });
      },
      "GET https://www.googleapis.com/youtube/v3/comments": (c) => {
        expect(c.url.searchParams.get("parentId")).toBe("UgBUSY");
        return json({
          items: [
            comment("UgBUSY.r1", "2026-10-22T08:00:00Z", "first reply"),
            comment("UgBUSY.r2", "2026-10-23T12:10:00Z", "a new reply hidden from the thread listing", "@sam", "UCsam", "vid2", "UgBUSY"),
          ],
        });
      },
      "GET https://www.googleapis.com/youtube/v3/videos": (c) => {
        expect(c.url.searchParams.get("id")!.split(",").sort()).toEqual(["vid1", "vid2"]);
        return json({ items: [{ id: "vid1", snippet: { title: "ER11 collet guide" } }, { id: "vid2", snippet: { title: "Voron build part 4" } }] });
      },
    });
    const yt = adapterFor();

    const first = await yt.inbound!.poll!(account(), null, m.ctx);
    expect(first.items).toEqual([]);
    expect(first.cursor).toBeTruthy();
    expect(listed).toBe(1);

    m.clock.t += 15 * 60_000;
    const fresh = thread(comment("UgNEW", "2026-10-23T12:05:00Z", "What collet size for a 3.175 mm bit?"), [
      comment("UgNEW.r1", "2026-10-23T12:07:00Z", "Same question!", "@bob", "UCbob", "vid1", "UgNEW"),
      comment("UgNEW.r2", "2026-10-23T12:08:00Z", "ER11-1/8 works", "@3dpandme", CHANNEL, "vid1", "UgNEW"),
    ]);
    const busy = thread(comment("UgBUSY", "2026-10-22T07:00:00Z", "Busy thread", "@kim", "UCkim", "vid2"), [comment("UgBUSY.r1", "2026-10-22T08:00:00Z", "first reply")], 2);
    const ours = thread(comment("UgOURS", "2026-10-23T12:09:00Z", "Pinned: links below", "@3dpandme", CHANNEL));
    threads = [ours, fresh, justBefore, busy, old];

    const second = await yt.inbound!.poll!(account(), first.cursor, m.ctx);
    expect(second.items.map((i) => [i.id, i.kind])).toEqual([
      ["UgNEW", "comment"],
      ["UgNEW.r1", "reply"],
      ["UgBUSY.r2", "reply"],
    ]);
    const [top, reply, hidden] = second.items;
    expect(top).toMatchObject({
      text: "What collet size for a 3.175 mm bit?",
      author: { id: "UCjane", name: "@jane", handle: "jane", url: "http://www.youtube.com/@jane" },
      url: "https://www.youtube.com/watch?v=vid1&lc=UgNEW",
      createdAt: "2026-10-23T12:05:00.000Z",
      replyTarget: { platform: "youtube", kind: "comment", id: "UgNEW", threadId: "UgNEW", videoId: "vid1" },
      context: { postId: "vid1", postUrl: "https://youtu.be/vid1", postText: "ER11 collet guide" },
    });
    expect(reply).toMatchObject({
      replyTarget: { platform: "youtube", kind: "reply", id: "UgNEW.r1", threadId: "UgNEW", videoId: "vid1", mention: "bob" },
      context: { parentText: "What collet size for a 3.175 mm bit?", postText: "ER11 collet guide" },
    });
    expect(hidden).toMatchObject({ context: { postText: "Voron build part 4", postUrl: "https://youtu.be/vid2" } });
    expect(m.of("GET https://www.googleapis.com/youtube/v3/comments")).toHaveLength(1);

    // Same listing again: nothing new, no reply or title lookups.
    m.clock.t += 15 * 60_000;
    const third = await yt.inbound!.poll!(account(), second.cursor, m.ctx);
    expect(third.items).toEqual([]);
    expect(m.of("GET https://www.googleapis.com/youtube/v3/comments")).toHaveLength(1);
    expect(m.of("GET https://www.googleapis.com/youtube/v3/videos")).toHaveLength(1);
    expect(JSON.parse(third.cursor!).recent.length).toBeLessThanOrEqual(10);
  });

  it("pages up to pollPages and restarts from now on an unreadable cursor", async () => {
    let page = 0;
    const m = mock({
      "GET https://www.googleapis.com/youtube/v3/commentThreads": () => {
        page++;
        return json({ items: [], nextPageToken: `p${page}` });
      },
    });
    const yt = adapterFor();
    const start = await yt.inbound!.poll!(account({ pollPages: 3 }), "garbage", m.ctx);
    expect(start.items).toEqual([]);
    expect(m.logs.join()).toContain("unreadable cursor");
    page = 0;
    await yt.inbound!.poll!(account({ pollPages: 3 }), start.cursor, m.ctx);
    const pages = m.of("GET https://www.googleapis.com/youtube/v3/commentThreads").slice(1);
    expect(pages.map((c) => c.url.searchParams.get("pageToken"))).toEqual([null, "p1", "p2"]);
  });
});

describe("youtube:auth helpers", () => {
  it("builds the consent URL for the loopback flow with PKCE and offline access", () => {
    const pkce = createPkce();
    const u = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:51234", state: "st", challenge: pkce.challenge }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: "http://127.0.0.1:51234",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state: "st",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl",
    });
    expect(pkce.challenge).not.toBe(pkce.verifier);
  });

  it("exchanges the code for a refresh token", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({ grant_type: "authorization_code", code: "the-code", code_verifier: "ver" });
      return json({ access_token: ACCESS, refresh_token: REFRESH, scope: "a b", expires_in: 3599 });
    });
    const t = await exchangeCode(fetch as unknown as typeof globalThis.fetch, { clientId: "c", clientSecret: CLIENT_SECRET, code: "the-code", verifier: "ver", redirectUri: "http://127.0.0.1:1" });
    expect(t).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, scope: ["a", "b"], expiresIn: 3599 });
  });
});
