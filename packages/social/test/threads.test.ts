import { beforeEach, describe, expect, it } from "vitest";
import { refreshThreadsToken, threadsAdapter } from "../src/adapters/threads";
import { metaTiming, MetaApiError } from "../src/adapters/meta/graph";
import { SocialAccount } from "../src";
import { caught, mockMeta } from "./meta-fetch";

const TOKEN = "THAAtestSECRETtoken456";
const UID = "26000000000000001";
const G = "https://graph.threads.com/v1.0";
const T = { access_token: TOKEN };

const account = SocialAccount.parse({
  id: "3dp-threads",
  platform: "threads",
  vertical: "3dpandme",
  handle: "@3dpandme",
  credentials: { accessToken: TOKEN, threadsUserId: UID },
});

const limitOk = { method: "GET" as const, url: `${G}/${UID}/threads_publishing_limit`, query: { fields: "quota_usage,config", ...T }, body: { data: [{ quota_usage: 1, config: { quota_total: 250, quota_duration: 86400 } }] } };
const status = (id: string, s: string) => ({ method: "GET" as const, url: `${G}/${id}`, query: { fields: "status,error_message", ...T }, body: { status: s, id } });
const publishOk = (creation: string, media: string) => ({ method: "POST" as const, url: `${G}/${UID}/threads_publish`, form: { creation_id: creation, ...T }, body: { id: media } });
const permalink = (media: string) => ({ method: "GET" as const, url: `${G}/${media}`, query: { fields: "permalink", ...T }, body: { permalink: `https://www.threads.com/@3dpandme/post/${media}`, id: media } });
const container = (form: Record<string, string>, id: string) => ({ method: "POST" as const, url: `${G}/${UID}/threads`, form: { ...form, ...T }, body: { id } });

beforeEach(() => {
  metaTiming.statusPollIntervalMs = 0;
  metaTiming.statusMaxAttempts = 5;
});

describe("threads validate", () => {
  it("checks length, links, media and credentials", () => {
    expect(threadsAdapter.capabilities).toMatchObject({ maxTextLength: 500, dm: false, inbound: true, media: ["image", "video"] });
    expect(threadsAdapter.sendDm).toBeUndefined();
    expect(threadsAdapter.validate(account, { text: "hello https://dms.test" })).toEqual([]);
    expect(threadsAdapter.validate(account, { text: "x".repeat(501) })).toEqual(["text is longer than 500 characters"]);
    expect(threadsAdapter.validate(account, { text: "", link: "https://dms.test/p" })).toEqual([]);
    const links = Array.from({ length: 6 }, (_, i) => `https://l${i}.test`).join(" ");
    expect(threadsAdapter.validate(account, { text: links })).toEqual(["at most 5 unique links per post"]);
    expect(threadsAdapter.validate(account, { text: "", media: Array(21).fill({ url: "https://x.test/a.jpg", type: "image" }) })).toContain(
      "at most 20 images/videos per carousel",
    );
    expect(threadsAdapter.credentials.safeParse({ accessToken: TOKEN, threadsUserId: UID }).success).toBe(true);
    expect(threadsAdapter.credentials.safeParse({ accessToken: "", threadsUserId: UID }).success).toBe(false);
  });
});

describe("threads publish", () => {
  it("publishes text with a link attachment", async () => {
    const m = mockMeta([
      limitOk,
      container({ media_type: "TEXT", text: "New post is up", link_attachment: "https://3dpandme.test/blog/1" }, "c1"),
      status("c1", "FINISHED"),
      publishOk("c1", "t1"),
      permalink("t1"),
    ]);
    const res = await threadsAdapter.publish(account, { text: "New post is up", link: "https://3dpandme.test/blog/1" }, m.ctx);
    expect(res).toEqual({ id: "t1", url: "https://www.threads.com/@3dpandme/post/t1" });
    m.done();
  });

  it("publishes an image", async () => {
    const m = mockMeta([
      limitOk,
      container({ media_type: "IMAGE", image_url: "https://cc.test/a.png", text: "Benchy", alt_text: "a boat" }, "c2"),
      status("c2", "FINISHED"),
      publishOk("c2", "t2"),
      permalink("t2"),
    ]);
    await threadsAdapter.publish(account, { text: "Benchy", media: [{ url: "https://cc.test/a.png", type: "image", alt: "a boat" }] }, m.ctx);
    m.done();
  });

  it("publishes a video, polling status", async () => {
    const m = mockMeta([
      limitOk,
      container({ media_type: "VIDEO", video_url: "https://cc.test/v.mp4", text: "Timelapse" }, "c3"),
      status("c3", "IN_PROGRESS"),
      status("c3", "FINISHED"),
      publishOk("c3", "t3"),
      permalink("t3"),
    ]);
    const res = await threadsAdapter.publish(account, { text: "Timelapse", media: [{ url: "https://cc.test/v.mp4", type: "video" }] }, m.ctx);
    expect(res.id).toBe("t3");
    m.done();
  });

  it("publishes a carousel with the link in the text", async () => {
    const m = mockMeta([
      limitOk,
      container({ media_type: "IMAGE", image_url: "https://cc.test/1.jpg", is_carousel_item: "true" }, "k1"),
      container({ media_type: "VIDEO", video_url: "https://cc.test/2.mp4", is_carousel_item: "true" }, "k2"),
      status("k2", "IN_PROGRESS"),
      status("k2", "FINISHED"),
      container({ media_type: "CAROUSEL", children: "k1,k2", text: "Build log\n\nhttps://3dpandme.test/b", reply_control: "followers_only" }, "car"),
      status("car", "FINISHED"),
      publishOk("car", "t4"),
      permalink("t4"),
    ]);
    await threadsAdapter.publish(
      account,
      {
        text: "Build log",
        link: "https://3dpandme.test/b",
        media: [
          { url: "https://cc.test/1.jpg", type: "image" },
          { url: "https://cc.test/2.mp4", type: "video" },
        ],
        options: { replyControl: "followers_only" },
      },
      m.ctx,
    );
    m.done();
  });

  it("surfaces container errors with Meta's reason", async () => {
    const m = mockMeta([
      limitOk,
      container({ media_type: "VIDEO", video_url: "https://cc.test/v.mp4" }, "c9"),
      { method: "GET", url: `${G}/c9`, query: { fields: "status,error_message", ...T }, body: { status: "ERROR", error_message: "INVALID_DURATION" } },
    ]);
    const err = await caught(() => threadsAdapter.publish(account, { text: "", media: [{ url: "https://cc.test/v.mp4", type: "video" }] }, m.ctx));
    expect(err.message).toBe("Threads media processing failed for container c9: INVALID_DURATION");
  });

  it("gives up on a container that never finishes", async () => {
    metaTiming.statusMaxAttempts = 2;
    const m = mockMeta([limitOk, container({ media_type: "TEXT", text: "hi" }, "c1"), status("c1", "IN_PROGRESS"), status("c1", "IN_PROGRESS")]);
    const err = await caught(() => threadsAdapter.publish(account, { text: "hi" }, m.ctx));
    expect(err.message).toMatch(/still processing/);
  });

  it("stops when the 250-post quota is used", async () => {
    const m = mockMeta([{ ...limitOk, body: { data: [{ quota_usage: 250, config: { quota_total: 250, quota_duration: 86400 } }] } }]);
    const err = await caught(() => threadsAdapter.publish(account, { text: "hi" }, m.ctx));
    expect(err.kind).toBe("rate_limit");
    expect(err.message).toBe("Threads publishing limit reached: 250/250 posts in the last 24h; retry later (the window is rolling)");
  });
});

describe("threads reply", () => {
  it("replies via reply_to_id", async () => {
    const m = mockMeta([container({ media_type: "TEXT", text: "Glad it helped!", reply_to_id: "r1" }, "c1"), status("c1", "FINISHED"), publishOk("c1", "t9"), permalink("t9")]);
    const res = await threadsAdapter.reply(account, { platform: "threads", kind: "reply", id: "r1" }, "Glad it helped!", m.ctx);
    expect(res).toEqual({ id: "t9", url: "https://www.threads.com/@3dpandme/post/t9" });
    m.done();
  });

  it("rejects DMs and over-long replies", async () => {
    const m = mockMeta([]);
    expect((await caught(() => threadsAdapter.reply(account, { platform: "threads", kind: "dm", id: "x" }, "hi", m.ctx))).message).toBe("Threads has no direct messages");
    expect((await caught(() => threadsAdapter.reply(account, { platform: "threads", kind: "reply", id: "x" }, "y".repeat(501), m.ctx))).message).toMatch(/longer than 500/);
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

describe("threads inbound", () => {
  const recent = {
    method: "GET" as const,
    url: `${G}/${UID}/threads`,
    query: { fields: "id,text,permalink,timestamp,has_replies", limit: "10", ...T },
    body: {
      data: [
        { id: "p1", text: "My new printer", permalink: "https://www.threads.com/@3dpandme/post/p1", timestamp: "2026-10-22T10:00:00+0000", has_replies: true },
        { id: "p2", text: "quiet post", timestamp: "2026-10-21T10:00:00+0000", has_replies: false },
      ],
    },
  };
  const conversation = (data: unknown[]) => ({
    method: "GET" as const,
    url: `${G}/p1/conversation`,
    query: { fields: "id,text,username,permalink,timestamp,replied_to,root_post,is_reply_owned_by_me", reverse: "true", limit: "50", ...T },
    body: { data },
  });
  const mentions = (data: unknown[], since = "1792756800") => ({
    method: "GET" as const,
    url: `${G}/${UID}/mentions`,
    query: { fields: "id,text,username,permalink,timestamp", since, limit: "50", ...T },
    body: { data },
  });

  it("first run returns no backlog", async () => {
    const m = mockMeta([]);
    const res = await threadsAdapter.inbound!.poll!(account, null, m.ctx);
    expect(res).toEqual({ items: [], cursor: JSON.stringify({ v: 1, since: "2026-10-23T12:00:00.000Z", seen: [] }) });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("returns new replies and mentions, skipping our own and old ones", async () => {
    const first = await threadsAdapter.inbound!.poll!(account, null, mockMeta([]).ctx);
    const m = mockMeta([
      recent,
      conversation([
        { id: "r3", text: "thanks!", username: "3dpandme", timestamp: "2026-10-23T12:06:00+0000", replied_to: { id: "r2" }, root_post: { id: "p1" }, is_reply_owned_by_me: true },
        { id: "r2", text: "which nozzle?", username: "bob", permalink: "https://www.threads.com/@bob/post/r2", timestamp: "2026-10-23T12:05:00+0000", replied_to: { id: "r1" }, root_post: { id: "p1" } },
        { id: "r1", text: "nice", username: "amy", timestamp: "2026-10-23T12:01:00+0000", replied_to: { id: "p1" }, root_post: { id: "p1" } },
        { id: "r0", text: "old", username: "amy", timestamp: "2026-10-23T09:00:00+0000", replied_to: { id: "p1" }, root_post: { id: "p1" } },
      ]),
      mentions([{ id: "x1", text: "@3dpandme have you tried this?", username: "cat", permalink: "https://www.threads.com/@cat/post/x1", timestamp: "2026-10-23T12:03:00+0000" }]),
    ]);
    const res = await threadsAdapter.inbound!.poll!(account, first.cursor, m.ctx);
    m.done();
    expect(res.items.map((i) => [i.id, i.kind])).toEqual([
      ["r1", "reply"],
      ["x1", "mention"],
      ["r2", "reply"],
    ]);
    expect(res.items[2]).toEqual({
      id: "r2",
      kind: "reply",
      author: { id: "bob", handle: "bob", url: "https://www.threads.com/@bob" },
      text: "which nozzle?",
      url: "https://www.threads.com/@bob/post/r2",
      createdAt: "2026-10-23T12:05:00.000Z",
      replyTarget: { platform: "threads", kind: "reply", id: "r2", rootId: "p1" },
      context: { postId: "p1", postUrl: "https://www.threads.com/@3dpandme/post/p1", postText: "My new printer", parentText: "nice" },
    });
    expect(res.items[1]!.replyTarget).toEqual({ platform: "threads", kind: "mention", id: "x1" });
    expect(JSON.parse(res.cursor!)).toEqual({ v: 1, since: "2026-10-23T12:05:00.000Z", seen: ["r1", "x1", "r2"] });

    // Same data again: nothing new.
    const m2 = mockMeta([
      recent,
      conversation([{ id: "r2", text: "which nozzle?", username: "bob", timestamp: "2026-10-23T12:05:00+0000", replied_to: { id: "r1" }, root_post: { id: "p1" } }]),
      mentions([], "1792757100"),
    ]);
    expect((await threadsAdapter.inbound!.poll!(account, res.cursor, m2.ctx)).items).toEqual([]);
    m2.done();
  });

  it("carries on without mentions when the permission is missing", async () => {
    const cursor = JSON.stringify({ v: 1, since: "2026-10-23T12:00:00.000Z", seen: [] });
    const m = mockMeta([
      { ...recent, body: { data: [] } },
      { ...mentions([]), status: 400, body: { error: { message: "Application does not have permission for this action", code: 10 } } },
    ]);
    const res = await threadsAdapter.inbound!.poll!(account, cursor, m.ctx);
    expect(res.items).toEqual([]);
    expect(m.logs.join("\n")).toMatch(/threads_manage_mentions/);
  });

  it("propagates rate limits from polling", async () => {
    const cursor = JSON.stringify({ v: 1, since: "2026-10-23T12:00:00.000Z", seen: [] });
    const m = mockMeta([{ ...recent, status: 429, headers: { "retry-after": "120" }, body: { error: { message: "Too many calls", code: 613 } } }]);
    const err = await caught(() => threadsAdapter.inbound!.poll!(account, cursor, m.ctx));
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.message).toBe(`Threads rate limited (code 613); retry after ~120s. GET /${UID}/threads: Too many calls`);
  });
});

describe("threads errors and tokens", () => {
  it("never leaks the token, even if Meta echoes it", async () => {
    const m = mockMeta([
      {
        ...container({ media_type: "TEXT", text: "hi", reply_to_id: "r1" }, "x"),
        status: 400,
        body: { error: { message: `Invalid parameter access_token=${TOKEN}&x=1 (${encodeURIComponent(TOKEN)})`, code: 100, error_subcode: 2207001, fbtrace_id: "f" } },
      },
    ]);
    const err = await caught(() => threadsAdapter.reply(account, { platform: "threads", kind: "reply", id: "r1" }, "hi", m.ctx));
    expect(err.message).toMatch(/^Threads API error \(code 100, subcode 2207001\)\. POST \/\d+\/threads: Invalid parameter/);
    expect(err.message).not.toContain(TOKEN);
    expect(err.subcode).toBe(2207001);
  });

  it("explains an invalid token", async () => {
    const m = mockMeta([{ ...container({ media_type: "TEXT", text: "hi", reply_to_id: "r1" }, "x"), status: 401, body: { error: { message: "Invalid OAuth access token", code: 190 } } }]);
    const err = await caught(() => threadsAdapter.reply(account, { platform: "threads", kind: "reply", id: "r1" }, "hi", m.ctx));
    expect(err.message).toMatch(/^Threads access token is invalid or was revoked \(code 190\)\. Threads long-lived tokens last 60 days/);
  });

  it("refreshes a long-lived token", async () => {
    const m = mockMeta([
      { method: "GET", url: "https://graph.threads.com/refresh_access_token", query: { grant_type: "th_refresh_token", ...T }, body: { access_token: "THnew", token_type: "bearer", expires_in: 5184000 } },
    ]);
    expect(await refreshThreadsToken(TOKEN, m.ctx)).toMatchObject({ accessToken: "THnew", expiresAt: "2026-12-22T12:00:00.000Z" });
    const m2 = mockMeta([
      { method: "GET", url: "https://graph.threads.com/refresh_access_token", query: { grant_type: "th_refresh_token", ...T }, body: { access_token: "THnew2", expires_in: 5184000 } },
    ]);
    expect((await threadsAdapter.refreshCredentials(account, m2.ctx)).credentials).toEqual({ accessToken: "THnew2", threadsUserId: UID });
  });
});
