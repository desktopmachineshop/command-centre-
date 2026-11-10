import { describe, expect, it, vi } from "vitest";
import {
  campaignSummary,
  createSocialExecutors,
  type NewScheduledPost,
  publishDueScheduledPosts,
  type ScheduledPost,
  type ScheduledPostStore,
} from "../src";
import { account, fakeAdapter } from "./fakes";

class MemoryScheduled implements ScheduledPostStore {
  posts: ScheduledPost[] = [];
  async insertScheduledPosts(list: NewScheduledPost[]) {
    const rows = list.map((p, i) => ({
      ...p,
      id: `sp-${this.posts.length + i + 1}`,
      publishAt: p.publishAt.toISOString(),
      status: "scheduled" as const,
      result: null,
      createdAt: "",
      updatedAt: "",
    }));
    this.posts.push(...rows);
    return rows;
  }
  async claimDueScheduledPosts(now: Date) {
    const due = this.posts.filter((p) => p.status === "scheduled" && new Date(p.publishAt) <= now);
    for (const p of due) p.status = "publishing";
    return due.map((p) => ({ ...p }));
  }
  async finishScheduledPost(id: string, status: "published" | "failed", result: unknown) {
    Object.assign(this.posts.find((p) => p.id === id)!, { status, result });
  }
}

const quiet = { info: () => {}, error: () => {} };

function setup() {
  const adapters = {
    instagram: fakeAdapter("instagram", { maxTextLength: 2200, requiresMedia: true, dm: false }, { sendDm: undefined }),
    x: fakeAdapter("x", { maxTextLength: 280, media: ["image"] }),
    reddit: fakeAdapter("reddit", { maxTextLength: 40000, requiresTitle: true, requiresTarget: true }),
  };
  const accounts = [
    account({ id: "3dp-ig", platform: "instagram", handle: "3dpandme" }),
    account({ id: "3dp-x", platform: "x", handle: "3dpandme" }),
    account({ id: "3dp-reddit", platform: "reddit" }),
    account({ id: "dms-x", platform: "x", vertical: "dms" }),
    account({ id: "dave-x", platform: "x", vertical: "personal", alsoVerticals: ["dms", "3dpandme"] }),
  ];
  const scheduled = new MemoryScheduled();
  const executors = createSocialExecutors(accounts, { adapters, scheduled, logger: quiet });
  return { adapters, accounts, scheduled, executors };
}

const image = { url: "https://cc.example/media/abc.jpg", type: "image" as const };

describe("social.post", () => {
  it("validates with the adapter, then publishes and returns id and url", async () => {
    const { executors, adapters } = setup();
    const result = await executors["social.post"].execute({ accountId: "3dp-x", content: { text: "New video!", media: [image] } });
    expect(result).toEqual({ id: "x-post-1", url: "https://x.example/x-post-1" });
    expect(adapters.x.published).toEqual([{ account: "3dp-x", content: { text: "New video!", media: [image] } }]);
  });

  it("rejects content the platform can't take, before publishing", async () => {
    const { executors, adapters } = setup();
    await expect(executors["social.post"].execute({ accountId: "3dp-x", content: { text: "x".repeat(281) } })).rejects.toThrow(
      "Can't post to 3dp-x (X): text is longer than 280 characters",
    );
    await expect(executors["social.post"].execute({ accountId: "3dp-ig", content: { text: "no media" } })).rejects.toThrow(
      /at least one image or video is required/,
    );
    expect(() => executors["social.post"].validate!({ accountId: "nope", content: { text: "hi" } }, { vertical: "3dpandme" })).toThrow(
      /Unknown social accountId "nope"/,
    );
    expect(adapters.x.published).toHaveLength(0);
  });

  it("rejects bad payloads and non-http media", async () => {
    const { executors } = setup();
    await expect(executors["social.post"].execute({ accountId: "3dp-x" })).rejects.toThrow(/Invalid social.post payload: content/);
    await expect(
      executors["social.post"].execute({ accountId: "3dp-x", content: { text: "hi", media: [{ url: "file:///etc/passwd", type: "image" }] } }),
    ).rejects.toThrow(/media url must be an http\(s\) URL/);
  });

  it("keeps a proposal to its own vertical's accounts", () => {
    const { executors } = setup();
    expect(() => executors["social.post"].validate!({ accountId: "dms-x", content: { text: "hi" } }, { vertical: "3dpandme" })).toThrow(
      'Social account "dms-x" belongs to dms, not 3dpandme',
    );
  });

  it("lets every business an account is shared with post from it (cross-posting)", () => {
    const { executors } = setup();
    for (const vertical of ["personal", "dms", "3dpandme"]) {
      expect(() => executors["social.post"].validate!({ accountId: "dave-x", content: { text: "hi" } }, { vertical })).not.toThrow();
    }
    expect(() => executors["social.post"].validate!({ accountId: "dave-x", content: { text: "hi" } }, { vertical: "openv" })).toThrow(
      'Social account "dave-x" belongs to personal and dms and 3dpandme, not openv',
    );
  });
});

describe("social.reply and social.dm", () => {
  it("replies through the adapter with the target unchanged", async () => {
    const { executors, adapters } = setup();
    const target = { platform: "instagram", kind: "comment", id: "c1", mediaId: "m1" };
    expect(await executors["social.reply"].execute({ accountId: "3dp-ig", target, text: "Thanks!" })).toMatchObject({ id: "instagram-reply-1" });
    expect(adapters.instagram.replies).toEqual([{ account: "3dp-ig", target, text: "Thanks!" }]);
  });

  it("refuses a target from another platform", async () => {
    const { executors, adapters } = setup();
    await expect(
      executors["social.reply"].execute({ accountId: "3dp-ig", target: { platform: "x", kind: "reply", id: "1" }, text: "hi" }),
    ).rejects.toThrow('Reply target is on X, but account "3dp-ig" is Instagram');
    expect(adapters.instagram.replies).toHaveLength(0);
  });

  it("sends DMs only where supported", async () => {
    const { executors, adapters } = setup();
    await executors["social.dm"].execute({ accountId: "3dp-x", userId: "u1", text: "hello" });
    expect(adapters.x.dms).toEqual([{ account: "3dp-x", userId: "u1", text: "hello" }]);
    await expect(executors["social.dm"].execute({ accountId: "3dp-ig", userId: "u1", text: "hello" })).rejects.toThrow(
      "Instagram direct messages are not supported",
    );
  });
});

describe("social.campaign", () => {
  const posts = [
    { accountId: "3dp-ig", content: { text: "New video: ER11 collets", media: [image] } },
    { accountId: "3dp-x", content: { text: "New video: ER11 collets https://youtu.be/x" } },
    { accountId: "3dp-reddit", content: { text: "Made a video", title: "ER11 collet guide", target: "hobbycnc", link: "https://youtu.be/x" } },
  ];

  it("checks every post up front and fails the whole campaign if any is invalid", async () => {
    const { executors, adapters } = setup();
    const bad = [...posts.slice(0, 2), { accountId: "3dp-reddit", content: { text: "no title" } }, { accountId: "3dp-x", content: { text: "x".repeat(300) } }];
    const run = () => executors["social.campaign"].validate!({ title: "Launch", posts: bad }, { vertical: "3dpandme" });
    expect(run).toThrow(/post 3 \(3dp-reddit, Reddit\): a title is required/);
    expect(run).toThrow(/post 3 \(3dp-reddit, Reddit\): a target is required/);
    expect(run).toThrow(/post 4 \(3dp-x, X\): text is longer than 280 characters/);
    await expect(executors["social.campaign"].execute({ title: "Launch", posts: bad })).rejects.toThrow(/invalid posts/);
    expect(adapters.instagram.published).toHaveLength(0);
    expect(adapters.x.published).toHaveLength(0);
  });

  it("publishes each post, and one platform failing doesn't stop the others", async () => {
    const { executors, adapters } = setup();
    adapters.x.failPublish = true;
    const result = await executors["social.campaign"].execute({ title: "Launch", posts });
    expect(result).toEqual({
      status: "partial",
      published: [
        { accountId: "3dp-ig", platform: "instagram", id: "instagram-post-1", url: "https://instagram.example/instagram-post-1" },
        { accountId: "3dp-reddit", platform: "reddit", id: "reddit-post-1", url: "https://reddit.example/reddit-post-1" },
      ],
      failed: [{ accountId: "3dp-x", platform: "x", error: "x is down" }],
    });
  });

  it("fails when every post fails", async () => {
    const { executors, adapters } = setup();
    adapters.x.failPublish = true;
    await expect(executors["social.campaign"].execute({ title: "Launch", posts: [posts[1]] })).rejects.toThrow("Every post failed: 3dp-x: x is down");
  });

  it("with publishAt, stores the posts and the publish job sends them when due", async () => {
    const { executors, adapters, scheduled, accounts } = setup();
    const result = (await executors["social.campaign"].execute({ title: "Launch", posts, publishAt: "2026-10-24T18:00:00+01:00" })) as any;
    expect(result).toMatchObject({ status: "scheduled", publishAt: "2026-10-24T17:00:00.000Z", when: "Sat 24 Oct, 18:00" });
    expect(result.posts).toHaveLength(3);
    expect(scheduled.posts.map((p) => [p.accountId, p.vertical, p.status])).toEqual([
      ["3dp-ig", "3dpandme", "scheduled"],
      ["3dp-x", "3dpandme", "scheduled"],
      ["3dp-reddit", "3dpandme", "scheduled"],
    ]);
    expect(adapters.instagram.published).toHaveLength(0);

    adapters.x.failPublish = true;
    const onFailure = vi.fn(async () => {});
    const run = (iso: string) =>
      publishDueScheduledPosts({ store: scheduled, accounts, adapters, onFailure, logger: quiet, now: () => new Date(iso) });
    expect(await run("2026-10-24T16:59:00Z")).toEqual({ published: 0, failed: 0 });
    expect(await run("2026-10-24T17:00:30Z")).toEqual({ published: 2, failed: 1 });
    expect(scheduled.posts.map((p) => p.status)).toEqual(["published", "failed", "published"]);
    expect(scheduled.posts[0]!.result).toEqual({ ok: true, id: "instagram-post-1", url: "https://instagram.example/instagram-post-1" });
    expect(scheduled.posts[1]!.result).toEqual({ ok: false, error: "x is down" });
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ accountId: "3dp-x" }), "x is down");
    // Published once: a later run finds nothing due.
    expect(await run("2026-10-24T17:05:00Z")).toEqual({ published: 0, failed: 0 });
  });

  it("rejects a malformed publishAt", () => {
    const { executors } = setup();
    expect(() => executors["social.campaign"].validate!({ title: "L", posts, publishAt: "tomorrow" }, { vertical: "3dpandme" })).toThrow(
      /publishAt must be an ISO date-time/,
    );
  });

  it("needs a scheduled-post store to schedule", () => {
    const { adapters, accounts } = setup();
    const executors = createSocialExecutors(accounts, { adapters, logger: quiet });
    expect(() =>
      executors["social.campaign"].validate!({ title: "L", posts, publishAt: "2026-10-24T18:00:00Z" }, { vertical: "3dpandme" }),
    ).toThrow("Scheduling is not available");
  });

  it("writes a short summary for a phone", () => {
    const { accounts } = setup();
    expect(campaignSummary({ title: "ER11 collet guide", posts, publishAt: "2026-10-24T17:00:00Z" }, accounts)).toBe(
      'Post "ER11 collet guide" to Instagram, X and Reddit · Sat 24 Oct, 18:00',
    );
    expect(campaignSummary({ title: "Hi", posts: posts.slice(1, 2) }, accounts)).toBe('Post "Hi" to X · now');
  });
});
