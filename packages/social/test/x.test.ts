import { describe, expect, it } from "vitest";
import type { AdapterContext, SocialAccount } from "../src";
import { adapters } from "../src";
import { createXAdapter, parseTweetId, xAdapter } from "../src/adapters/x";
import { XApiError } from "../src/adapters/x/errors";
import { authorizationHeader, percentEncode, sign, signatureBaseString } from "../src/adapters/x/oauth1";
import { extractUrls, weightedLength } from "../src/adapters/x/text";

const creds = {
  apiKey: "ck-AAAAAAAAAAAAAAAAAAAAAAAA",
  apiSecret: "cs-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  accessToken: "123-CCCCCCCCCCCCCCCCCCCCCCCC",
  accessTokenSecret: "ts-DDDDDDDDDDDDDDDDDDDDDDDDDDDD",
};
const SECRET_VALUES = Object.values(creds);

const account: SocialAccount = {
  id: "3dp-x",
  platform: "x",
  vertical: "3dpandme",
  handle: "@3dpandme",
  inbound: false,
  credentials: creds,
  options: {},
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | undefined;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fake fetch: each call goes to the first handler that answers it. */
function harness(handlers: Handler[]) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = init?.body;
    if (typeof body === "string" && headers["content-type"] === "application/json") body = JSON.parse(body);
    const call = { method: init?.method ?? "GET", url, headers, body };
    calls.push(call);
    for (const h of handlers) {
      const res = h(call);
      if (res) return res;
    }
    throw new Error(`unexpected fetch ${call.method} ${url}`);
  }) as typeof fetch;
  const ctx: AdapterContext = {
    fetch: fetchImpl,
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    now: () => new Date("2026-10-23T12:00:00Z"),
  };
  return { ctx, calls, logs };
}

const on = (method: string, path: string, respond: (call: Call) => Response): Handler => (call) =>
  call.method === method && new URL(call.url).pathname === path ? respond(call) : undefined;

/** POST /2/tweets that hands out ids 1001, 1002, ... */
function tweets(): Handler {
  let next = 1001;
  return on("POST", "/2/tweets", (call) => json(201, { data: { id: String(next++), text: (call.body as { text: string }).text } }));
}

const noSleep = async () => {};

describe("OAuth 1.0a signing", () => {
  // The worked example from X's "Creating a signature" page.
  const req = {
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    bodyParams: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
  };
  const oauth = {
    oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
    oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1318622958",
    oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    oauth_version: "1.0",
  };
  const consumerSecret = "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw";
  const tokenSecret = "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE";

  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("Ladies + Gentlemen!*'()~")).toBe("Ladies%20%2B%20Gentlemen%21%2A%27%28%29~");
  });

  it("builds the documented signature base string and signature", () => {
    const base = signatureBaseString(req, oauth);
    expect(base).toBe(
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
    expect(sign(base, consumerSecret, tokenSecret)).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });

  it("matches the current docs' api.x.com variant of the example", () => {
    const base = signatureBaseString({ ...req, url: "https://api.x.com/1.1/statuses/update.json?include_entities=true" }, oauth);
    expect(sign(base, consumerSecret, tokenSecret)).toBe("Ls93hJiZbQ3akF3HF3x1Bz8/zU4=");
  });

  it("builds the Authorization header", () => {
    const header = authorizationHeader(
      req,
      { consumerKey: oauth.oauth_consumer_key, consumerSecret, token: oauth.oauth_token, tokenSecret },
      { nonce: oauth.oauth_nonce, timestamp: 1318622958 },
    );
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });
});

describe("weighted length", () => {
  it("counts Latin text as 1 per character", () => {
    expect(weightedLength("Hello world")).toBe(11);
    expect(weightedLength("x".repeat(280))).toBe(280);
  });

  it("counts every URL as 23", () => {
    const long = `https://desktopmachineshop.com/shop/${"a".repeat(200)}`;
    expect(weightedLength(`New kit: ${long}`)).toBe(9 + 23);
    expect(weightedLength("see desktopmachineshop.com/shop.")).toBe(4 + 23 + 1);
    expect(weightedLength("http://a.co")).toBe(23);
    expect(extractUrls("Read (https://3dpandme.com/blog/x), then www.example.org!")).toEqual([
      "https://3dpandme.com/blog/x",
      "www.example.org",
    ]);
    // Emails and @handles aren't links.
    expect(extractUrls("mail dave@desktopmachineshop.com or @3dpandme")).toEqual([]);
  });

  it("counts emoji and CJK as 2", () => {
    expect(weightedLength("🔥")).toBe(2);
    expect(weightedLength("👨‍👩‍👧‍👦")).toBe(2); // ZWJ family
    expect(weightedLength("👍🏽")).toBe(2); // skin tone
    expect(weightedLength("🇬🇧")).toBe(2); // flag
    expect(weightedLength("日本語")).toBe(6);
    expect(weightedLength("—“quotes”")).toBe(9); // dashes and curly quotes weigh 1
    expect(weightedLength("…")).toBe(2); // U+2026 is outside twitter-text's light ranges
  });

  it("normalises to NFC", () => {
    expect(weightedLength("café")).toBe(4);
  });
});

describe("x adapter", () => {
  it("is registered with posting-only capabilities", () => {
    expect(adapters.x).toBe(xAdapter);
    expect(xAdapter.capabilities).toMatchObject({ publish: true, reply: true, dm: false, inbound: false, maxTextLength: 280, media: ["image", "video"] });
    expect(xAdapter.inbound).toBeUndefined();
    expect(xAdapter.sendDm).toBeUndefined();
    expect(xAdapter.credentials.safeParse(creds).success).toBe(true);
    expect(xAdapter.credentials.safeParse({ apiKey: "a" }).success).toBe(false);
  });

  it("validates with weighted counting and X's media rules", () => {
    const v = (c: Parameters<typeof xAdapter.validate>[1]) => xAdapter.validate(account, c);
    // 250 chars + a 300-char URL: fine on X, though it's 550 code points.
    expect(v({ text: `${"a".repeat(250)} https://3dpandme.com/${"p".repeat(280)}` })).toEqual([]);
    expect(v({ text: "🔥".repeat(141) })[0]).toMatch(/282 weighted characters/);
    // The link is appended after a space: 256 + 1 + 23 = 280.
    expect(v({ text: "x".repeat(256), link: "https://3dpandme.com/a-very-long-blog-post-url" })).toEqual([]);
    expect(v({ text: "x".repeat(257), link: "https://3dpandme.com/a" })[0]).toMatch(/281 weighted/);
    const img = { url: "https://media.example/a.jpg", type: "image" as const };
    const vid = { url: "https://media.example/a.mp4", type: "video" as const };
    expect(v({ text: "hi", media: [img, img, img, img, img] })).toContain("X allows at most 4 images per post");
    expect(v({ text: "hi", media: [vid, vid] })).toContain("X allows at most 1 video per post");
    expect(v({ text: "hi", media: [img, vid] })).toContain("X can't mix images and a video in one post");
    expect(v({ text: "hi", title: "T" })).toContain("X posts have no title; put it in the text");
    expect(v({ text: "hi", options: { thread: ["ok", "y".repeat(281), " "] } })).toEqual([
      "thread post 3 is 281 weighted characters; X allows 280",
      "thread post 4 is empty",
    ]);
    expect(v({ text: "hi", options: { thread: "nope" } })).toEqual(["options.thread must be an array of strings"]);
  });

  it("posts with OAuth 1.0a and returns the post URL", async () => {
    const { ctx, calls } = harness([tweets()]);
    const res = await xAdapter.publish(account, { text: "New video is up!", link: "https://youtu.be/abc" }, ctx);
    expect(res).toEqual({ id: "1001", url: "https://x.com/3dpandme/status/1001" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.x.com/2/tweets");
    expect(calls[0]!.body).toEqual({ text: "New video is up! https://youtu.be/abc" });
    const auth = calls[0]!.headers.authorization!;
    expect(auth).toMatch(/^OAuth /);
    expect(auth).toContain(`oauth_consumer_key="${creds.apiKey}"`);
    expect(auth).toContain(`oauth_token="${creds.accessToken}"`);
    expect(auth).toContain(`oauth_timestamp="${Date.parse("2026-10-23T12:00:00Z") / 1000}"`);
    expect(auth).not.toContain(creds.apiSecret);
    expect(auth).not.toContain(creds.accessTokenSecret);
  });

  it("posts a thread as a reply chain and returns the first post", async () => {
    const { ctx, calls } = harness([tweets()]);
    const res = await xAdapter.publish(account, { text: "1/ Tramming your spindle", options: { thread: ["2/ Loosen the bolts", "3/ Done"] } }, ctx);
    expect(res).toEqual({ id: "1001", url: "https://x.com/3dpandme/status/1001" });
    expect(calls.map((c) => c.body)).toEqual([
      { text: "1/ Tramming your spindle" },
      { text: "2/ Loosen the bolts", reply: { in_reply_to_tweet_id: "1001" } },
      { text: "3/ Done", reply: { in_reply_to_tweet_id: "1002" } },
    ]);
  });

  it("says how far a thread got when a later post fails", async () => {
    let n = 0;
    const { ctx } = harness([
      on("POST", "/2/tweets", () => (++n === 1 ? json(201, { data: { id: "1001", text: "a" } }) : json(503, { title: "Service Unavailable" }))),
    ]);
    const err = await xAdapter.publish(account, { text: "a", options: { thread: ["b", "c"] } }, ctx).catch((e: unknown) => e as Error) as Error;
    expect(err.message).toMatch(/only partly posted \(1 of 3\); the first post is https:\/\/x\.com\/3dpandme\/status\/1001/);
  });

  it("uploads images (with alt text) and attaches them", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    let mediaId = 500;
    const { ctx, calls } = harness([
      (c) => (c.url.startsWith("https://media.example/") ? new Response(png, { headers: { "content-type": "image/png" } }) : undefined),
      on("POST", "/2/media/upload", () => json(200, { data: { id: String(mediaId++), media_key: "3_x" } })),
      on("POST", "/2/media/metadata", () => json(200, { data: { associated_metadata: true } })),
      tweets(),
    ]);
    const res = await xAdapter.publish(
      account,
      {
        text: "Fresh prints",
        media: [
          { url: "https://media.example/u/a.png", type: "image", alt: "A blue benchy" },
          { url: "https://media.example/u/b.png", type: "image" },
        ],
      },
      ctx,
    );
    expect(res.id).toBe("1001");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /u/a.png",
      "POST /2/media/upload",
      "POST /2/media/metadata",
      "GET /u/b.png",
      "POST /2/media/upload",
      "POST /2/tweets",
    ]);
    // The media host is fetched without X credentials.
    expect(calls[0]!.headers.authorization).toBeUndefined();
    const form = calls[1]!.body as FormData;
    expect(form.get("media_category")).toBe("tweet_image");
    const blob = form.get("media") as Blob;
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    expect(calls[1]!.headers.authorization).toMatch(/^OAuth /);
    expect(calls[2]!.body).toEqual({ id: "500", metadata: { alt_text: { text: "A blue benchy" } } });
    expect(calls[5]!.body).toEqual({ text: "Fresh prints", media: { media_ids: ["500", "501"] } });
  });

  it("uploads video in chunks and waits for processing", async () => {
    const video = new Uint8Array(9 * 1024 * 1024); // 9 MB: three 4 MB segments
    const sleeps: number[] = [];
    let statusChecks = 0;
    const { ctx, calls } = harness([
      (c) => (c.url === "https://media.example/v.mp4" ? new Response(video, { headers: { "content-type": "video/mp4" } }) : undefined),
      on("POST", "/2/media/upload/initialize", () => json(200, { data: { id: "777", media_key: "7_777", expires_after_secs: 86400 } })),
      on("POST", "/2/media/upload/777/append", () => new Response(null, { status: 204 })),
      on("POST", "/2/media/upload/777/finalize", () =>
        json(200, { data: { id: "777", processing_info: { state: "pending", check_after_secs: 1 } } })),
      on("GET", "/2/media/upload", () =>
        json(200, { data: { id: "777", processing_info: ++statusChecks < 2 ? { state: "in_progress", check_after_secs: 3 } : { state: "succeeded" } } })),
      tweets(),
    ]);
    const adapter = createXAdapter({ sleep: async (ms) => void sleeps.push(ms) });
    await adapter.publish(account, { text: "Build video", media: [{ url: "https://media.example/v.mp4", type: "video", alt: "ignored" }] }, ctx);

    const paths = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(paths).toEqual([
      "GET /v.mp4",
      "POST /2/media/upload/initialize",
      "POST /2/media/upload/777/append",
      "POST /2/media/upload/777/append",
      "POST /2/media/upload/777/append",
      "POST /2/media/upload/777/finalize",
      "GET /2/media/upload",
      "GET /2/media/upload",
      "POST /2/tweets",
    ]);
    expect(calls[1]!.body).toEqual({ media_type: "video/mp4", total_bytes: video.byteLength, media_category: "tweet_video" });
    const segs = calls.slice(2, 5).map((c) => c.body as FormData);
    expect(segs.map((f) => f.get("segment_index"))).toEqual(["0", "1", "2"]);
    expect(segs.map((f) => (f.get("media") as Blob).size)).toEqual([4194304, 4194304, 1048576]);
    const status = new URL(calls[6]!.url);
    expect(Object.fromEntries(status.searchParams)).toEqual({ command: "STATUS", media_id: "777" });
    // The query string is signed, so the header must differ from an unsigned one; just check it's there.
    expect(calls[6]!.headers.authorization).toMatch(/oauth_signature=/);
    expect(sleeps).toEqual([1000, 3000]);
    expect(calls[8]!.body).toEqual({ text: "Build video", media: { media_ids: ["777"] } });
  });

  it("fails clearly when video processing fails", async () => {
    const { ctx } = harness([
      (c) => (c.url === "https://media.example/v.mp4" ? new Response(new Uint8Array(10), { headers: { "content-type": "video/mp4" } }) : undefined),
      on("POST", "/2/media/upload/initialize", () => json(200, { data: { id: "9" } })),
      on("POST", "/2/media/upload/9/append", () => new Response(null, { status: 204 })),
      on("POST", "/2/media/upload/9/finalize", () => json(200, { data: { id: "9", processing_info: { state: "failed", error: { message: "InvalidMedia" } } } })),
    ]);
    await expect(createXAdapter({ sleep: noSleep }).publish(account, { text: "v", media: [{ url: "https://media.example/v.mp4", type: "video" }] }, ctx)).rejects.toThrow(
      /couldn't process the media: InvalidMedia/,
    );
  });

  it("replies to a known post id or a pasted post URL", async () => {
    const { ctx, calls } = harness([tweets()]);
    await xAdapter.reply(account, { platform: "x", kind: "mention", id: "1849000000000000000" }, "Thanks!", ctx);
    await xAdapter.reply(account, { platform: "x", kind: "reply", id: "https://twitter.com/someone/status/1849000000000000001?s=20" }, "Cheers", ctx);
    expect(calls.map((c) => c.body)).toEqual([
      { text: "Thanks!", reply: { in_reply_to_tweet_id: "1849000000000000000" } },
      { text: "Cheers", reply: { in_reply_to_tweet_id: "1849000000000000001" } },
    ]);
    await expect(xAdapter.reply(account, { platform: "x", kind: "mention", id: "@someone" }, "Hi", ctx)).rejects.toThrow(/known post id/);
    await expect(xAdapter.reply(account, { platform: "x", kind: "mention", id: "1" }, "y".repeat(281), ctx)).rejects.toThrow(/281 weighted/);
    expect(calls).toHaveLength(2);
  });

  it("parses post ids", () => {
    expect(parseTweetId("https://x.com/3dpandme/status/123456")).toBe("123456");
    expect(parseTweetId("https://mobile.twitter.com/a_b/statuses/42/photo/1")).toBe("42");
    expect(parseTweetId("https://x.com/i/web/status/99")).toBe("99");
    expect(parseTweetId("https://evil.example/x.com/a/status/1")).toBeUndefined();
    expect(parseTweetId(7)).toBeUndefined();
  });

  it("rejects incomplete credentials without echoing them", async () => {
    const { ctx, calls } = harness([tweets()]);
    const bad = { ...account, credentials: { apiKey: creds.apiKey, apiSecret: creds.apiSecret } };
    const err = await xAdapter.publish(bad, { text: "hi" }, ctx).catch((e: unknown) => e as Error) as Error;
    expect(err.message).toMatch(/incomplete: accessToken, accessTokenSecret required/);
    expect(err.message).not.toContain(creds.apiKey);
    expect(calls).toHaveLength(0);
  });
});

describe("x error mapping", () => {
  const post = async (res: Response) => {
    const { ctx } = harness([on("POST", "/2/tweets", () => res)]);
    return (await xAdapter.publish(account, { text: "hi" }, ctx).catch((e: unknown) => e)) as XApiError;
  };

  it("429 reports when the limit resets", async () => {
    const reset = Date.parse("2026-10-23T12:14:00Z") / 1000;
    const err = await post(json(429, { title: "Too Many Requests", detail: "Too Many Requests" }, { "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(reset) }));
    expect(err).toBeInstanceOf(XApiError);
    expect(err.status).toBe(429);
    expect(err.resetAt?.toISOString()).toBe("2026-10-23T12:14:00.000Z");
    expect(err.message).toMatch(/resets at 2026-10-23T12:14:00.000Z \(in 14 min\)/);
  });

  it("429 on the 24-hour posting cap uses the 24-hour reset", async () => {
    const reset = Date.parse("2026-10-24T09:30:00Z") / 1000;
    const err = await post(
      json(429, { title: "Too Many Requests" }, {
        "x-rate-limit-remaining": "99",
        "x-rate-limit-reset": String(Date.parse("2026-10-23T12:10:00Z") / 1000),
        "x-user-limit-24hour-remaining": "0",
        "x-user-limit-24hour-reset": String(reset),
      }),
    );
    expect(err.message).toMatch(/resets at 2026-10-24T09:30:00.000Z \(in 21 h 30 min\)/);
  });

  it("403 explains the usual free-tier causes", async () => {
    const err = await post(
      json(403, {
        title: "Forbidden",
        detail: "You are not permitted to perform this action.",
        type: "https://api.twitter.com/2/problems/client-forbidden",
        reason: "client-not-enrolled",
      }),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/Read and write/);
    expect(err.message).toMatch(/regenerate the access token/);
    expect(err.message).toMatch(/reason: client-not-enrolled/);
  });

  it("402 says the credits ran out", async () => {
    const err = await post(json(402, { title: "CreditsDepleted", detail: "Your enrolled account does not have any credits." }));
    expect(err.message).toMatch(/no API credits left/);
  });

  it("never leaks secrets, even if X or a proxy echoes them", async () => {
    const echoed = `bad request oauth_consumer_key="${creds.apiKey}" secret=${creds.apiSecret} ${encodeURIComponent(creds.accessTokenSecret)} token ${creds.accessToken}`;
    for (const status of [400, 401, 403, 429, 500]) {
      const err = await post(new Response(echoed, { status }));
      for (const s of SECRET_VALUES) {
        expect(err.message).not.toContain(s);
        expect(err.message).not.toContain(encodeURIComponent(s));
      }
      expect(err.message).toContain("[redacted]");
    }
  });

  it("redacts network errors too", async () => {
    const ctx = harness([]).ctx;
    ctx.fetch = (async () => {
      throw new Error(`connect failed for ${creds.accessToken}`);
    }) as typeof fetch;
    const err = (await xAdapter.publish(account, { text: "hi" }, ctx).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Couldn't reach X/);
    expect(err.message).not.toContain(creds.accessToken);
  });
});
