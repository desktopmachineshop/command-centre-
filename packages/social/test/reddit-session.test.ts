import { describe, expect, it } from "vitest";
import {
  type AdapterContext,
  createSocialExecutors,
  isRedditSessionAccount,
  MemorySubmissionStore,
  nextSlot,
  type OutboxEntry,
  pacingFor,
  parseSessionCookie,
  redditSessionWhoami,
  RedditSessionExpiredError,
  sendDueSubmissions,
  sendQueuedSubmission,
  type SocialAccount,
  validateSocialCredentials,
} from "../src";
import { createRedditAdapter, RedditCredentials } from "../src/adapters/reddit";

const COOKIE = "1234567%2C2026-11-01T10-00-00%2Cabcdef0123456789abcdef0123456789abcdef01";
const MODHASH = "modhash-abc123";

const account = (over: Partial<SocialAccount> = {}): SocialAccount => ({
  id: "dms-reddit",
  platform: "reddit",
  vertical: "dms",
  inbound: true,
  handle: "u/dave_dms",
  credentials: { sessionCookie: COOKIE },
  options: {},
  ...over,
});

type Call = { url: URL; method: string; headers: Record<string, string>; form: URLSearchParams | null };

/**
 * A fake old.reddit.com that speaks the cookie-session protocol: /api/me.json gives the modhash
 * only to the right cookie, and POSTs need both the cookie and the modhash.
 */
function fakeOldReddit(state: { signedIn?: boolean; blocked?: boolean; rateLimit?: string; inbox?: Record<string, unknown>[]; suspended?: boolean } = {}) {
  const s = { signedIn: true, blocked: false, inbox: [] as Record<string, unknown>[], ...state };
  const calls: Call[] = [];
  const comments: { thing_id: string; text: string }[] = [];
  const posts: Record<string, string>[] = [];
  const messages: Record<string, string>[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, form: init?.body ? new URLSearchParams(String(init.body)) : null };
    calls.push(call);
    if (call.url.origin !== "https://old.reddit.com") throw new Error(`unexpected host ${call.url.origin}`);
    if (s.blocked) return new Response("<html><body>whoa there, pardner!</body></html>", { status: 403, headers: { "content-type": "text/html" } });
    const authed = s.signedIn && call.headers.Cookie?.includes(`reddit_session=${COOKIE}`);
    const path = call.url.pathname;
    if (path === "/api/me.json") return json(authed ? { kind: "t2", data: { name: "dave_dms", modhash: MODHASH, link_karma: 120, comment_karma: 3400, is_suspended: s.suspended === true } } : {});
    if (call.method === "POST") {
      if (!authed) return json({ json: { errors: [["USER_REQUIRED", "Please log in to do that.", null]] } });
      if (call.form?.get("uh") !== MODHASH || call.headers["X-Modhash"] !== MODHASH) return json({ message: "Forbidden", error: 403 }, 403);
      if (s.rateLimit) return json({ json: { errors: [["RATELIMIT", s.rateLimit, "ratelimit"]] } });
      const form = Object.fromEntries(call.form!);
      if (path === "/api/comment") {
        comments.push({ thing_id: form.thing_id!, text: form.text! });
        const id = `c${comments.length}`;
        return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id, name: `t1_${id}`, permalink: `/r/hobbycnc/comments/abc12/x/${id}/` } }] } } });
      }
      if (path === "/api/submit") {
        posts.push(form);
        return json({ json: { errors: [], data: { url: `https://old.reddit.com/r/${form.sr}/comments/new1/title/`, id: "new1", name: "t3_new1" } } });
      }
      if (path === "/api/compose") {
        messages.push(form);
        return json({ json: { errors: [] } });
      }
    }
    if (!authed) return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (path === "/message/inbox.json") {
      const before = call.url.searchParams.get("before");
      const limit = Number(call.url.searchParams.get("limit") ?? 25);
      const all = s.inbox; // newest first
      const idx = before ? all.findIndex((m) => m.name === before) : all.length;
      const rows = before ? (idx < 0 ? [] : all.slice(0, idx)) : all;
      return json({ kind: "Listing", data: { children: rows.slice(0, limit).map((data) => ({ kind: String(data.name).slice(0, 2), data })) } });
    }
    if (path === "/message/sent.json") return json({ kind: "Listing", data: { children: messages.length ? [{ kind: "t4", data: { name: "t4_sent1", id: "sent1", dest: messages.at(-1)!.to } }] : [] } });
    if (path === "/api/info.json") return json({ kind: "Listing", data: { children: [{ kind: "t3", data: { name: "t3_abc12", selftext: "Which collets?", title: "Collets" } }] } });
    return json({ message: "Not Found", error: 404 }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls, comments, posts, messages, state: s };
}

function context(fetch: typeof globalThis.fetch, at = "2026-11-09T12:00:00Z") {
  const clock = { now: new Date(at) };
  const ctx: AdapterContext = { fetch, log: { info: () => {}, error: () => {} }, now: () => clock.now };
  return { ctx, clock };
}

const target = (id = "t3_abc12") => ({ platform: "reddit" as const, kind: "comment" as const, id, subreddit: "hobbycnc" });

describe("Reddit session credentials", () => {
  it("accepts a session cookie without any app keys, and still needs app keys without one", () => {
    expect(RedditCredentials.safeParse({ sessionCookie: COOKIE }).success).toBe(true);
    expect(isRedditSessionAccount(account())).toBe(true);
    expect(() => validateSocialCredentials([account()], { reddit: createRedditAdapter() })).not.toThrow();
    const none = RedditCredentials.safeParse({});
    expect(none.success ? [] : none.error.issues.map((i) => i.message)).toEqual(["clientId is required", "clientSecret is required", "username is required", "password is required", "userAgent is required"]);
  });

  it("takes the cookie as a bare value, name=value, or a pasted Cookie header, and never echoes it", () => {
    expect(parseSessionCookie(` ${COOKIE} `)).toEqual({ session: COOKIE });
    expect(parseSessionCookie(`reddit_session=${COOKIE}`)).toEqual({ session: COOKIE });
    expect(parseSessionCookie(`Cookie: loid=abc; token_v2=eyJhbGciOi.payload.sig; reddit_session=${COOKIE}; theme=dark`)).toEqual({ session: COOKIE, tokenV2: "eyJhbGciOi.payload.sig" });
    expect(parseSessionCookie(COOKIE, "tok-123")).toEqual({ session: COOKIE, tokenV2: "tok-123" });
    for (const bad of ["loid=abc; theme=dark", "has spaces in the value 1234567890", `${COOKIE}\r\nX-Injected: 1`, "abc123xyz"]) {
      let message = "";
      try {
        parseSessionCookie(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, bad).not.toBe("");
      expect(message).not.toContain(bad);
    }
    const parsed = RedditCredentials.safeParse({ sessionCookie: "a=b; c=d" });
    expect(parsed.success ? "" : parsed.error.issues[0]!.message).toMatch(/no reddit_session cookie/);
  });
});

describe("Reddit adapter in session mode", () => {
  it("replies with the cookie and modhash on old.reddit.com, with an honest User-Agent and no API token", async () => {
    const reddit = fakeOldReddit();
    const { ctx } = context(reddit.fetch);
    const res = await createRedditAdapter().reply(account(), target(), "ER11 is the one you want.", ctx);
    expect(res).toEqual({ id: "t1_c1", url: "https://www.reddit.com/r/hobbycnc/comments/abc12/x/c1/" });
    expect(reddit.comments).toEqual([{ thing_id: "t3_abc12", text: "ER11 is the one you want." }]);
    expect(reddit.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /api/me.json", "POST /api/comment"]);
    const post = reddit.calls[1]!;
    expect(post.headers.Cookie).toBe(`reddit_session=${COOKIE}`);
    expect(post.headers["X-Modhash"]).toBe(MODHASH);
    expect(post.form!.get("uh")).toBe(MODHASH);
    expect(post.form!.get("api_type")).toBe("json");
    expect(post.headers["User-Agent"]).toBe("web:command-centre:1.0 (by /u/dave_dms)");
    expect(post.headers["User-Agent"]).not.toMatch(/Mozilla|Chrome|Safari|Firefox/);
    expect(post.headers.Authorization).toBeUndefined();
    // The modhash is reused for the next submission.
    await createRedditAdapter().reply(account(), target("t1_xyz"), "And a second.", ctx);
  });

  it("publishes a text post and sends a DM", async () => {
    const reddit = fakeOldReddit();
    const { ctx } = context(reddit.fetch);
    const adapter = createRedditAdapter();
    const post = await adapter.publish(account(), { text: "Body", title: "A title", target: "r/hobbycnc" }, ctx);
    expect(post).toEqual({ id: "t3_new1", url: "https://www.reddit.com/r/hobbycnc/comments/new1/title/" });
    expect(reddit.posts[0]).toMatchObject({ sr: "hobbycnc", title: "A title", kind: "self", text: "Body", uh: MODHASH });
    const dm = await adapter.sendDm!(account({ handle: undefined }), "u/maker1", "Hello", ctx);
    expect(dm.id).toBe("t4_sent1");
    // With no handle saved, the account's name comes from Reddit itself.
    expect(reddit.messages[0]).toMatchObject({ to: "maker1", subject: "Message from u/dave_dms", text: "Hello" });
  });

  it("says to reconnect on the Accounts page when the session no longer signs in", async () => {
    const reddit = fakeOldReddit({ signedIn: false });
    const { ctx } = context(reddit.fetch);
    const err = await createRedditAdapter()
      .reply(account(), target(), "hello", ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedditSessionExpiredError);
    expect((err as Error).message).toMatch(/no longer accepts the saved session for u\/dave_dms.*Reconnect Reddit on the Accounts page/);
    expect((err as Error).message).not.toContain(COOKIE);
    expect((err as { reconnect: boolean }).reconnect).toBe(true);
    expect(reddit.comments).toEqual([]);
    // The inbox poll reports the same thing.
    await expect(createRedditAdapter().inbound!.poll!(account(), null, ctx)).rejects.toBeInstanceOf(RedditSessionExpiredError);
  });

  it("notices a session that expires between submissions", async () => {
    const reddit = fakeOldReddit();
    const { ctx } = context(reddit.fetch);
    const adapter = createRedditAdapter();
    await adapter.reply(account(), target(), "first", ctx);
    reddit.state.signedIn = false; // signed out elsewhere; the cached modhash is now useless
    await expect(adapter.reply(account(), target(), "second", ctx)).rejects.toBeInstanceOf(RedditSessionExpiredError);
    expect(reddit.comments).toHaveLength(1);
  });

  it("fails clearly when Reddit blocks the request, and does nothing to get round it", async () => {
    const reddit = fakeOldReddit({ blocked: true });
    const { ctx } = context(reddit.fetch);
    const err = (await createRedditAdapter()
      .reply(account(), target(), "hello", ctx)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Reddit refused the session check \(HTTP 403\).*blocking this server.*nothing was posted/);
    expect(err).not.toBeInstanceOf(RedditSessionExpiredError);
    expect(reddit.calls).toHaveLength(1); // one attempt, no retries
  });

  it("surfaces Reddit's own RATELIMIT and a suspended account", async () => {
    const limited = fakeOldReddit({ rateLimit: "you are doing that too much. try again in 9 minutes." });
    const err = (await createRedditAdapter()
      .reply(account(), target(), "hello", context(limited.fetch).ctx)
      .catch((e: unknown) => e)) as Error & { codes: string[] };
    expect(err.message).toMatch(/rate limited by Reddit \(you are doing that too much\. try again in 9 minutes\.\)/);
    expect(err.codes).toEqual(["RATELIMIT"]);
    const suspended = fakeOldReddit({ suspended: true });
    await expect(createRedditAdapter().reply(account(), target(), "hello", context(suspended.fetch).ctx)).rejects.toThrow(/suspended u\/dave_dms/);
    expect(suspended.comments).toEqual([]);
  });

  it("polls the inbox with the cookie", async () => {
    const msg = (name: string, created: string, over: Record<string, unknown> = {}) => ({ name, id: name.slice(3), author: "maker1", body: `body of ${name}`, created_utc: Date.parse(created) / 1000, subreddit: "hobbycnc", context: "/r/hobbycnc/comments/abc12/x/" + name.slice(3) + "/?context=3", parent_id: "t3_abc12", type: "post_reply", was_comment: true, link_title: "Collets", ...over });
    const reddit = fakeOldReddit({ inbox: [msg("t1_old1", "2026-11-09T11:00:00Z")] });
    const { ctx } = context(reddit.fetch);
    const adapter = createRedditAdapter();
    const first = await adapter.inbound!.poll!(account(), null, ctx);
    expect(first.items).toEqual([]);
    reddit.state.inbox.unshift(msg("t1_new1", "2026-11-09T12:30:00Z"), msg("t1_mine", "2026-11-09T12:20:00Z", { author: "Dave_DMS" }));
    const second = await adapter.inbound!.poll!(account(), first.cursor, ctx);
    expect(second.items.map((i) => i.id)).toEqual(["t1_new1"]);
    expect(second.items[0]).toMatchObject({ kind: "comment", text: "body of t1_new1", replyTarget: { platform: "reddit", id: "t1_new1", subreddit: "hobbycnc" }, context: { parentText: "Which collets?" } });
    expect(reddit.calls.every((c) => c.headers.Cookie === `reddit_session=${COOKIE}`)).toBe(true);
    expect(reddit.calls.some((c) => c.url.pathname === "/message/inbox.json" && c.url.searchParams.get("mark") === "false")).toBe(true);
  });

  it("tests a connection: username and karma", async () => {
    const reddit = fakeOldReddit();
    const me = await redditSessionWhoami({ sessionCookie: `reddit_session=${COOKIE}` }, context(reddit.fetch).ctx);
    expect(me).toMatchObject({ name: "dave_dms", linkKarma: 120, commentKarma: 3400, suspended: false });
    await expect(redditSessionWhoami({ sessionCookie: COOKIE }, context(fakeOldReddit({ signedIn: false }).fetch).ctx)).rejects.toBeInstanceOf(RedditSessionExpiredError);
  });
});

describe("pacing", () => {
  const limits = { minGapMs: 10 * 60_000, dailyCap: 3 };
  const at = (iso: string) => new Date(iso);

  it("finds the next slot from the gap and the 24-hour cap", () => {
    const now = at("2026-11-09T12:00:00Z");
    expect(nextSlot([], now, limits)).toEqual(now);
    expect(nextSlot([at("2026-11-09T11:40:00Z")], now, limits)).toEqual(now);
    expect(nextSlot([at("2026-11-09T11:55:00Z")], now, limits)).toEqual(at("2026-11-09T12:05:00Z"));
    // Queued ones count too: each takes the slot after the last.
    expect(nextSlot([at("2026-11-09T11:55:00Z"), at("2026-11-09T12:05:00Z")], now, limits)).toEqual(at("2026-11-09T12:15:00Z"));
    // Three in the last 24 hours: the next goes when the oldest is a day old.
    expect(nextSlot([at("2026-11-08T20:00:00Z"), at("2026-11-09T08:00:00Z"), at("2026-11-09T09:00:00Z")], now, limits)).toEqual(at("2026-11-09T20:00:00Z"));
    expect(nextSlot([at("2026-11-08T11:00:00Z"), at("2026-11-09T08:00:00Z"), at("2026-11-09T09:00:00Z")], now, limits)).toEqual(now);
  });

  it("paces Reddit session accounts by default, API accounts only when asked", () => {
    const adapter = createRedditAdapter();
    expect(pacingFor(account(), adapter)).toEqual({ minGapMs: 600_000, dailyCap: 8 });
    expect(pacingFor(account({ options: { minGapMinutes: 30, dailyCap: "4" } }), adapter)).toEqual({ minGapMs: 1_800_000, dailyCap: 4 });
    const api = account({ credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" } });
    expect(pacingFor(api, adapter)).toBeNull();
    expect(pacingFor({ ...api, options: { dailyCap: 5 } }, adapter)).toEqual({ minGapMs: 0, dailyCap: 5 });
  });

  function setup(options: Record<string, unknown> = {}) {
    const reddit = fakeOldReddit();
    const { clock } = context(reddit.fetch);
    const store = new MemorySubmissionStore();
    const accounts = [account({ options })];
    const adapters = { reddit: createRedditAdapter() };
    const authErrors: string[] = [];
    const quiet = { info: () => {}, error: () => {} };
    const executors = createSocialExecutors(accounts, { adapters, fetch: reddit.fetch, now: () => clock.now, submissions: store, logger: quiet, onAuthError: (a, m) => void authErrors.push(`${a.id}: ${m}`) });
    const failures: string[] = [];
    const drain = () => sendDueSubmissions({ store, accounts, adapters, send: sendQueuedSubmission, fetch: reddit.fetch, now: () => clock.now, logger: quiet, onFailure: async (e: OutboxEntry, error) => void failures.push(`${e.id}: ${error}`) });
    const reply = (text: string) => executors["social.reply"].execute({ accountId: "dms-reddit", target: target(), text });
    const tick = (minutes: number) => (clock.now = new Date(clock.now.getTime() + minutes * 60_000));
    return { reddit, clock, store, executors, drain, reply, tick, failures, authErrors };
  }

  it("sends the first approved reply at once and queues the rest ten minutes apart", async () => {
    const t = setup();
    expect(await t.reply("one")).toEqual({ id: "t1_c1", url: "https://www.reddit.com/r/hobbycnc/comments/abc12/x/c1/" });
    const second = (await t.reply("two")) as Record<string, unknown>;
    expect(second).toMatchObject({ status: "scheduled", sendAt: "2026-11-09T12:10:00.000Z" });
    expect(second.reason).toMatch(/Reddit @?u\/dave_dms is paced: at least 10 min between submissions and at most 8 in 24 hours/);
    expect(await t.reply("three")).toMatchObject({ status: "scheduled", sendAt: "2026-11-09T12:20:00.000Z" });
    expect(t.reddit.comments.map((c) => c.text)).toEqual(["one"]);

    expect(await t.drain()).toEqual({ sent: 0, failed: 0, waiting: 0 });
    t.tick(10);
    expect(await t.drain()).toEqual({ sent: 1, failed: 0, waiting: 0 });
    expect(await t.drain()).toEqual({ sent: 0, failed: 0, waiting: 0 }); // sent once, not again
    t.tick(10);
    expect(await t.drain()).toEqual({ sent: 1, failed: 0, waiting: 0 });
    expect(t.reddit.comments.map((c) => c.text)).toEqual(["one", "two", "three"]);
    expect(t.store.outbox.map((e) => e.status)).toEqual(["sent", "sent"]);
  });

  it("never releases a burst after the sender was down", async () => {
    const t = setup();
    await t.reply("one");
    await t.reply("two");
    await t.reply("three");
    t.tick(120); // both queued replies are long overdue
    expect(await t.drain()).toEqual({ sent: 1, failed: 0, waiting: 1 });
    t.tick(1);
    expect(await t.drain()).toEqual({ sent: 0, failed: 0, waiting: 1 });
    t.tick(9);
    expect(await t.drain()).toEqual({ sent: 1, failed: 0, waiting: 0 });
    expect(t.reddit.comments).toHaveLength(3);
  });

  it("holds to the daily cap across posts, replies and DMs", async () => {
    const t = setup({ dailyCap: 2, minGapMinutes: 0 });
    await t.reply("one");
    await t.executors["social.post"].execute({ accountId: "dms-reddit", content: { text: "Body", title: "T", target: "hobbycnc" } });
    const third = (await t.executors["social.dm"].execute({ accountId: "dms-reddit", userId: "maker1", text: "hi" })) as Record<string, unknown>;
    expect(third).toMatchObject({ status: "scheduled", sendAt: "2026-11-10T12:00:00.000Z" });
    expect(t.reddit.messages).toEqual([]);
    t.tick(24 * 60);
    expect(await t.drain()).toMatchObject({ sent: 1 });
    expect(t.reddit.messages).toHaveLength(1);
  });

  it("refuses a campaign post that would break the pace, with the time it could go", async () => {
    const t = setup();
    await t.reply("one");
    await expect(t.executors["social.campaign"].execute({ title: "News", posts: [{ accountId: "dms-reddit", content: { text: "Body", title: "T", target: "hobbycnc" } }] })).rejects.toThrow(/is paced \(at least 10 min.*next submission can go at 2026-11-09T12:10:00.000Z/);
    expect(t.reddit.posts).toEqual([]);
  });

  it("reports a queued reply that fails, without retrying it, and an expired session when it is found", async () => {
    const t = setup();
    await t.reply("one");
    await t.reply("two");
    t.reddit.state.rateLimit = "you are doing that too much. try again in 5 minutes.";
    t.tick(10);
    expect(await t.drain()).toEqual({ sent: 0, failed: 1, waiting: 0 });
    expect(t.failures[0]).toMatch(/rate limited by Reddit/);
    t.tick(60);
    expect(await t.drain()).toEqual({ sent: 0, failed: 0, waiting: 0 });

    t.reddit.state.signedIn = false;
    t.tick(20);
    await expect(t.reply("three")).rejects.toBeInstanceOf(RedditSessionExpiredError);
    expect(t.authErrors).toHaveLength(1);
    expect(t.authErrors[0]).toMatch(/dms-reddit: .*Reconnect Reddit on the Accounts page/);
  });

  it("without a store, still enforces the limits with a clear error", async () => {
    const reddit = fakeOldReddit();
    const { clock } = context(reddit.fetch);
    const executors = createSocialExecutors([account()], { adapters: { reddit: createRedditAdapter() }, fetch: reddit.fetch, now: () => clock.now });
    const payload = { accountId: "dms-reddit", target: target(), text: "hello" };
    await executors["social.reply"].execute(payload);
    await expect(executors["social.reply"].execute(payload)).rejects.toThrow(/is paced.*2026-11-09T12:10:00.000Z/);
    expect(reddit.comments).toHaveLength(1);
  });
});
