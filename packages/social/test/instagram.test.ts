import { beforeEach, describe, expect, it } from "vitest";
import { instagramAdapter, refreshInstagramToken } from "../src/adapters/instagram";
import { metaTiming, MetaApiError } from "../src/adapters/meta/graph";
import { SocialAccount } from "../src";
import { caught, mockMeta } from "./meta-fetch";

const TOKEN = "IGAAtestSECRETtoken123";
const IG = "17841400000000001";
const G = "https://graph.instagram.com/v26.0";
const T = { access_token: TOKEN };

const account = SocialAccount.parse({
  id: "3dp-instagram",
  platform: "instagram",
  vertical: "3dpandme",
  handle: "3dpandme",
  credentials: { accessToken: TOKEN, igUserId: IG },
});

const limitOk = { method: "GET" as const, url: `${G}/${IG}/content_publishing_limit`, query: { fields: "quota_usage,config", ...T }, body: { data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] } };
const status = (id: string, code: string) => ({ method: "GET" as const, url: `${G}/${id}`, query: { fields: "status_code,status", ...T }, body: { status_code: code, id } });
const publishOk = (creation: string, media: string) => ({ method: "POST" as const, url: `${G}/${IG}/media_publish`, form: { creation_id: creation, ...T }, body: { id: media } });
const permalink = (media: string) => ({ method: "GET" as const, url: `${G}/${media}`, query: { fields: "permalink", ...T }, body: { permalink: `https://www.instagram.com/p/${media}/`, id: media } });

beforeEach(() => {
  metaTiming.statusPollIntervalMs = 0;
  metaTiming.statusMaxAttempts = 5;
});

describe("instagram validate", () => {
  it("accepts a good post and the credentials schema", () => {
    expect(instagramAdapter.validate(account, { text: "New build #cnc", media: [{ url: "https://x.test/a.jpg", type: "image" }] })).toEqual([]);
    expect(instagramAdapter.credentials.safeParse({ accessToken: TOKEN, igUserId: IG }).success).toBe(true);
    expect(instagramAdapter.credentials.safeParse({ accessToken: TOKEN }).success).toBe(false);
    expect(instagramAdapter.capabilities).toMatchObject({ maxTextLength: 2200, requiresMedia: true, dm: true, media: ["image", "video"] });
  });

  it("rejects missing media, long captions, PNGs, too many items and hashtags", () => {
    expect(instagramAdapter.validate(account, { text: "hi" })).toContain("at least one image or video is required");
    const img = { url: "https://x.test/a.jpg", type: "image" as const };
    expect(instagramAdapter.validate(account, { text: "x".repeat(2201), media: [img] })).toContain("text is longer than 2200 characters");
    // the link is appended to the caption and counts towards the limit
    expect(instagramAdapter.validate(account, { text: "x".repeat(2190), link: "https://example.com/abc", media: [img] })).toContain(
      "text is longer than 2200 characters",
    );
    expect(instagramAdapter.validate(account, { text: "", media: [{ url: "https://x.test/a.png", type: "image" }] })).toEqual([
      "Instagram only accepts JPEG images: https://x.test/a.png",
    ]);
    expect(instagramAdapter.validate(account, { text: "", media: Array(21).fill(img) })).toContain("at most 20 images/videos per carousel");
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(instagramAdapter.validate(account, { text: tags, media: [img] })).toContain("at most 30 hashtags");
  });

  it("refuses to publish invalid content without calling the API", async () => {
    const m = mockMeta([]);
    const err = await caught(() => instagramAdapter.publish(account, { text: "no media" }, m.ctx));
    expect(err.message).toMatch(/not publishable: at least one image/);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("reports bad credentials by field without echoing values", async () => {
    const bad = { ...account, credentials: { accessToken: TOKEN, igUserId: "me" } };
    const err = await caught(() => instagramAdapter.reply(bad, { platform: "instagram", kind: "comment", id: "1" }, "hi", mockMeta([]).ctx));
    expect(err.message).toContain("igUserId");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("instagram publish", () => {
  it("publishes a single image and returns the permalink", async () => {
    const m = mockMeta([
      limitOk,
      { method: "POST", url: `${G}/${IG}/media`, form: { image_url: "https://cc.test/u/a.jpg", caption: "Fresh chips\n\nhttps://dms.test/x", alt_text: "a mill", ...T }, body: { id: "c1" } },
      status("c1", "FINISHED"),
      publishOk("c1", "m1"),
      permalink("m1"),
    ]);
    const res = await instagramAdapter.publish(
      account,
      { text: "Fresh chips", link: "https://dms.test/x", media: [{ url: "https://cc.test/u/a.jpg", type: "image", alt: "a mill" }] },
      m.ctx,
    );
    expect(res).toEqual({ id: "m1", url: "https://www.instagram.com/p/m1/" });
    m.done();
  });

  it("publishes a carousel, waiting for video children", async () => {
    const m = mockMeta([
      limitOk,
      { method: "POST", url: `${G}/${IG}/media`, form: { image_url: "https://cc.test/1.jpg", is_carousel_item: "true", ...T }, body: { id: "k1" } },
      { method: "POST", url: `${G}/${IG}/media`, form: { media_type: "VIDEO", video_url: "https://cc.test/2.mp4", is_carousel_item: "true", ...T }, body: { id: "k2" } },
      status("k2", "IN_PROGRESS"),
      status("k2", "FINISHED"),
      { method: "POST", url: `${G}/${IG}/media`, form: { media_type: "CAROUSEL", children: "k1,k2", caption: "Two views", ...T }, body: { id: "car" } },
      status("car", "FINISHED"),
      publishOk("car", "m2"),
      permalink("m2"),
    ]);
    const res = await instagramAdapter.publish(
      account,
      {
        text: "Two views",
        media: [
          { url: "https://cc.test/1.jpg", type: "image" },
          { url: "https://cc.test/2.mp4", type: "video" },
        ],
      },
      m.ctx,
    );
    expect(res.id).toBe("m2");
    m.done();
  });

  it("publishes a video as a reel, polling status until FINISHED", async () => {
    const m = mockMeta([
      limitOk,
      { method: "POST", url: `${G}/${IG}/media`, form: { media_type: "REELS", video_url: "https://cc.test/r.mp4", caption: "Timelapse", share_to_feed: "true", ...T }, body: { id: "r1" } },
      status("r1", "IN_PROGRESS"),
      status("r1", "IN_PROGRESS"),
      status("r1", "FINISHED"),
      publishOk("r1", "m3"),
      permalink("m3"),
    ]);
    const res = await instagramAdapter.publish(
      account,
      { text: "Timelapse", media: [{ url: "https://cc.test/r.mp4", type: "video" }], options: { shareToFeed: true } },
      m.ctx,
    );
    expect(res).toEqual({ id: "m3", url: "https://www.instagram.com/p/m3/" });
    m.done();
  });

  it("surfaces a processing ERROR and a stuck container", async () => {
    const m = mockMeta([
      limitOk,
      { method: "POST", url: `${G}/${IG}/media`, form: { media_type: "REELS", video_url: "https://cc.test/r.mp4", ...T }, body: { id: "r1" } },
      { method: "GET", url: `${G}/r1`, query: { fields: "status_code,status", ...T }, body: { status_code: "ERROR", status: "Error: video too long" } },
    ]);
    const err = await caught(() => instagramAdapter.publish(account, { text: "", media: [{ url: "https://cc.test/r.mp4", type: "video" }] }, m.ctx));
    expect(err.message).toBe("Instagram media processing failed for container r1: Error: video too long");
  });

  it("stops before creating containers when the publishing limit is used up", async () => {
    const m = mockMeta([{ ...limitOk, body: { data: [{ quota_usage: 100, config: { quota_total: 100, quota_duration: 86400 } }] } }]);
    const err = await caught(() => instagramAdapter.publish(account, { text: "x", media: [{ url: "https://cc.test/a.jpg", type: "image" }] }, m.ctx));
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.kind).toBe("rate_limit");
    expect(err.message).toMatch(/publishing limit reached: 100\/100 API posts in the last 24h/);
    m.done();
  });

  it("maps the publish-limit error code from media_publish", async () => {
    const m = mockMeta([
      limitOk,
      { method: "POST", url: `${G}/${IG}/media`, form: { image_url: "https://cc.test/a.jpg", ...T }, body: { id: "c1" } },
      status("c1", "FINISHED"),
      { ...publishOk("c1", "x"), status: 400, body: { error: { message: "Application request limit reached", type: "OAuthException", code: 9, error_subcode: 2207042, fbtrace_id: "t" } } },
    ]);
    const err = await caught(() => instagramAdapter.publish(account, { text: "", media: [{ url: "https://cc.test/a.jpg", type: "image" }] }, m.ctx));
    expect(err.kind).toBe("rate_limit");
    expect(err.message).toContain("content publishing limit reached (code 9, subcode 2207042)");
  });
});

describe("instagram reply and DM", () => {
  it("replies to a top-level comment", async () => {
    const m = mockMeta([{ method: "POST", url: `${G}/c55/replies`, form: { message: "Thanks!", ...T }, body: { id: "c56" } }]);
    const res = await instagramAdapter.reply(account, { platform: "instagram", kind: "comment", id: "c55" }, "Thanks!", m.ctx);
    expect(res).toEqual({ id: "c56", url: undefined });
    m.done();
  });

  it("answers a reply on its top-level comment, addressed to the author", async () => {
    const m = mockMeta([{ method: "POST", url: `${G}/c55/replies`, form: { message: "@bob Yes, 6mm", ...T }, body: { id: "c57" } }]);
    await instagramAdapter.reply(account, { platform: "instagram", kind: "comment", id: "c55", commentId: "c60", mention: "bob" }, "Yes, 6mm", m.ctx);
    m.done();
  });

  it("replies to a DM via the Send API", async () => {
    const m = mockMeta([
      { method: "POST", url: `${G}/${IG}/messages`, query: T, json: { recipient: { id: "IGSID9" }, message: { text: "Hi there" } }, body: { recipient_id: "IGSID9", message_id: "mid.1" } },
    ]);
    const res = await instagramAdapter.reply(account, { platform: "instagram", kind: "dm", id: "IGSID9" }, "Hi there", m.ctx);
    expect(res).toEqual({ id: "mid.1" });
    m.done();
  });

  it("explains the 24h messaging window", async () => {
    const m = mockMeta([
      {
        method: "POST",
        url: `${G}/${IG}/messages`,
        query: T,
        json: { recipient: { id: "u1" }, message: { text: "late" } },
        status: 400,
        body: { error: { message: "This message is sent outside of allowed window.", code: 10, error_subcode: 2534022 } },
      },
    ]);
    const err = await caught(() => instagramAdapter.sendDm!(account, "u1", "late", m.ctx));
    expect(err.message).toBe("Instagram DM not sent: you can only message a user within 24 hours of their last message to this account (code 10, subcode 2534022)");
  });
});

describe("instagram inbound", () => {
  const mediaList = (counts: Record<string, number>) => ({
    method: "GET" as const,
    url: `${G}/${IG}/media`,
    query: { fields: "id,caption,permalink,timestamp,comments_count", limit: "10", ...T },
    body: {
      data: Object.entries(counts).map(([id, comments_count]) => ({ id, caption: `caption ${id}`, permalink: `https://www.instagram.com/p/${id}/`, timestamp: "2026-10-20T10:00:00+0000", comments_count })),
    },
  });
  const commentsReq = (media: string, data: unknown[]) => ({
    method: "GET" as const,
    url: `${G}/${media}/comments`,
    query: { fields: "id,text,timestamp,username,from,parent_id,replies{id,text,timestamp,username,from,parent_id}", limit: "50", ...T },
    body: { data },
  });
  const convs = (data: unknown[]) => ({
    method: "GET" as const,
    url: `${G}/${IG}/conversations`,
    query: { platform: "instagram", fields: "id,updated_time", limit: "20", ...T },
    body: { data },
  });

  it("first run makes no calls and starts the cursor at now", async () => {
    const m = mockMeta([]);
    const res = await instagramAdapter.inbound!.poll!(account, null, m.ctx);
    expect(res.items).toEqual([]);
    expect(JSON.parse(res.cursor!)).toEqual({ v: 1, since: "2026-10-23T12:00:00.000Z", seen: [], counts: {}, dm: { since: "2026-10-23T12:00:00.000Z", seen: [] } });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(instagramAdapter.inbound!.pollIntervalSeconds).toBe(300);
  });

  it("returns new comments, replies and DMs, then skips unchanged media", async () => {
    const first = await instagramAdapter.inbound!.poll!(account, null, mockMeta([]).ctx);
    const m = mockMeta([
      mediaList({ m1: 3, m2: 0 }),
      commentsReq("m1", [
        { id: "old", text: "before", timestamp: "2026-10-23T11:00:00+0000", username: "amy", from: { id: "u-amy", username: "amy" } },
        {
          id: "c1",
          text: "What endmill? @3dpandme",
          timestamp: "2026-10-23T12:01:00+0000",
          username: "bob",
          from: { id: "u-bob", username: "bob" },
          replies: {
            data: [
              { id: "c2", text: "6mm", timestamp: "2026-10-23T12:02:00+0000", username: "3dpandme", from: { id: IG, username: "3dpandme" }, parent_id: "c1" },
              { id: "c3", text: "cheers", timestamp: "2026-10-23T12:03:00+0000", username: "bob", from: { id: "u-bob", username: "bob" }, parent_id: "c1" },
            ],
          },
        },
      ]),
      convs([
        { id: "conv1", updated_time: "2026-10-23T12:04:00+0000" },
        { id: "conv-old", updated_time: "2026-10-22T09:00:00+0000" },
      ]),
      {
        method: "GET",
        url: `${G}/conv1`,
        query: { fields: "messages.limit(20){id,created_time,from,message}", ...T },
        body: {
          messages: {
            data: [
              { id: "mid.2", created_time: "2026-10-23T12:05:00+0000", from: { id: IG, username: "3dpandme" }, message: "our reply" },
              { id: "mid.1", created_time: "2026-10-23T12:04:00+0000", from: { id: "u-cat", username: "cat" }, message: "Do you sell spindles?" },
            ],
          },
        },
      },
    ]);
    const res = await instagramAdapter.inbound!.poll!(account, first.cursor, m.ctx);
    m.done();
    expect(res.items.map((i) => [i.id, i.kind])).toEqual([
      ["c1", "comment"],
      ["c3", "comment"],
      ["mid.1", "dm"],
    ]);
    expect(res.items[0]).toEqual({
      id: "c1",
      kind: "comment",
      author: { id: "u-bob", handle: "bob", url: "https://www.instagram.com/bob/" },
      text: "What endmill? @3dpandme",
      url: "https://www.instagram.com/p/m1/",
      createdAt: "2026-10-23T12:01:00.000Z",
      replyTarget: { platform: "instagram", kind: "comment", id: "c1", commentId: "c1", mediaId: "m1", postUrl: "https://www.instagram.com/p/m1/" },
      context: { postId: "m1", postUrl: "https://www.instagram.com/p/m1/", postText: "caption m1", parentText: undefined },
    });
    expect(res.items[1]!.replyTarget).toMatchObject({ id: "c1", commentId: "c3", mention: "bob" });
    expect(res.items[1]!.context?.parentText).toBe("What endmill? @3dpandme");
    expect(res.items[2]!.replyTarget).toEqual({ platform: "instagram", kind: "dm", id: "u-cat", conversationId: "conv1" });
    expect(JSON.parse(res.cursor!)).toMatchObject({ since: "2026-10-23T12:03:00.000Z", seen: ["c1", "c3"], counts: { m1: 3, m2: 0 }, dm: { since: "2026-10-23T12:04:00.000Z", seen: ["mid.1"] } });

    // Next poll: comment counts unchanged, so no comment reads; no conversation updates.
    const m2 = mockMeta([mediaList({ m1: 3, m2: 0 }), convs([{ id: "conv1", updated_time: "2026-10-23T12:04:00+0000" }]), {
      method: "GET",
      url: `${G}/conv1`,
      query: { fields: "messages.limit(20){id,created_time,from,message}", ...T },
      body: { messages: { data: [{ id: "mid.1", created_time: "2026-10-23T12:04:00+0000", from: { id: "u-cat", username: "cat" }, message: "Do you sell spindles?" }] } },
    }]);
    const again = await instagramAdapter.inbound!.poll!(account, res.cursor, m2.ctx);
    m2.done();
    expect(again.items).toEqual([]);
  });

  it("keeps polling comments when the token cannot read DMs", async () => {
    const cursor = JSON.stringify({ v: 1, since: "2026-10-23T12:00:00.000Z", seen: [], counts: {}, dm: { since: "2026-10-23T12:00:00.000Z", seen: [] } });
    const m = mockMeta([
      mediaList({}),
      { ...convs([]), status: 403, body: { error: { message: "(#10) Application does not have permission for this action", code: 10 } } },
    ]);
    const res = await instagramAdapter.inbound!.poll!(account, cursor, m.ctx);
    expect(res.items).toEqual([]);
    expect(m.logs.join("\n")).toMatch(/could not read DMs/);
    expect(m.logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("instagram errors and tokens", () => {
  const reply = (ctx: ReturnType<typeof mockMeta>["ctx"]) => instagramAdapter.reply(account, { platform: "instagram", kind: "comment", id: "c1" }, "hi", ctx);
  const req = { method: "POST" as const, url: `${G}/c1/replies`, form: { message: "hi", ...T } };

  it("says clearly when the token expired, with codes and no token", async () => {
    const m = mockMeta([
      { ...req, status: 400, body: { error: { message: `Error validating access token: Session has expired. token=${TOKEN}`, type: "OAuthException", code: 190, error_subcode: 463, fbtrace_id: "abc" } } },
    ]);
    const err = await caught(() => reply(m.ctx));
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/^Instagram access token has expired \(code 190, subcode 463\)\. Instagram long-lived tokens last 60 days/);
    expect(err.message).toContain("SOCIAL_ACCOUNTS");
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it("maps throttling codes to 'rate limited, retry after'", async () => {
    const m = mockMeta([
      {
        ...req,
        status: 400,
        headers: { "x-business-use-case-usage": JSON.stringify({ [IG]: [{ type: "instagram", call_count: 100, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 5 }] }) },
        body: { error: { message: "Application request limit reached", code: 4 } },
      },
    ]);
    const err = await caught(() => reply(m.ctx));
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterSeconds).toBe(300);
    expect(err.message).toBe("Instagram rate limited (code 4); retry after ~300s. POST /c1/replies: Application request limit reached");
  });

  it.each([17, 32, 613, 80002])("treats code %i as a rate limit", async (code) => {
    const m = mockMeta([{ ...req, status: 400, body: { error: { message: "slow down", code } } }]);
    const err = await caught(() => reply(m.ctx));
    expect(err.kind).toBe("rate_limit");
    expect(err.message).toMatch(/rate limited \(code \d+\); retry later/);
  });

  it("redacts the token from network errors and other messages", async () => {
    const ctx = mockMeta([]).ctx;
    ctx.fetch = (async (input: string) => {
      throw new TypeError(`fetch failed for ${input}`);
    }) as unknown as typeof fetch;
    const err = await caught(() => instagramAdapter.inbound!.poll!(account, JSON.stringify({ v: 1, since: "2026-10-23T12:00:00.000Z" }), ctx));
    expect(err.message).toMatch(/^Instagram network error: GET \//);
    expect(err.message).not.toContain(TOKEN);
  });

  it("honours ctx.signal", async () => {
    const ctx = mockMeta([]).ctx;
    const ac = new AbortController();
    ac.abort();
    ctx.signal = ac.signal;
    ctx.fetch = ((_: string, init: RequestInit) => Promise.reject(init.signal!.reason)) as unknown as typeof fetch;
    const err = await caught(() => reply(ctx));
    expect(err.message).toBe("Instagram request aborted: POST /c1/replies");
  });

  it("refreshes a long-lived token", async () => {
    const m = mockMeta([
      { method: "GET", url: "https://graph.instagram.com/refresh_access_token", query: { grant_type: "ig_refresh_token", ...T }, body: { access_token: "IGAAnew", token_type: "bearer", expires_in: 5184000 } },
    ]);
    expect(await refreshInstagramToken(TOKEN, m.ctx)).toEqual({ accessToken: "IGAAnew", expiresInSeconds: 5184000, expiresAt: "2026-12-22T12:00:00.000Z" });
  });

  it("refreshCredentials explains an expired token", async () => {
    const m = mockMeta([
      { method: "GET", url: "https://graph.instagram.com/refresh_access_token", query: { grant_type: "ig_refresh_token", ...T }, status: 400, body: { error: { message: "Session has expired", code: 190, error_subcode: 463 } } },
    ]);
    const err = await caught(() => instagramAdapter.refreshCredentials(account, m.ctx));
    expect(err.message).toMatch(/access token has expired .*Generate token/);
  });
});
