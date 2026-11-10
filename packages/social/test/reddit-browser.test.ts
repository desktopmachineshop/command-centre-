import { RedditBrowserPayload, type RedditBrowserResult } from "@cc/core";
import { describe, expect, it } from "vitest";
import {
  type AdapterContext,
  type BrowserJobOptions,
  type BrowserJobs,
  createSocialExecutors,
  isRedditBrowserAccount,
  isRedditSessionAccount,
  MemorySubmissionStore,
  type OutboxEntry,
  PcOfflineError,
  pacingFor,
  redditBrowserWhoami,
  RedditBrowserSignedOutError,
  sendDueSubmissions,
  sendQueuedSubmission,
  type SocialAccount,
  validateSocialCredentials,
} from "../src";
import { createRedditAdapter, RedditCredentials } from "../src/adapters/reddit";

const account = (over: Partial<SocialAccount> = {}): SocialAccount => ({
  id: "dms-reddit",
  platform: "reddit",
  vertical: "dms",
  inbound: true,
  handle: "u/dave_dms",
  credentials: { browserNode: "studio-pc" },
  options: {},
  ...over,
});

const user = { name: "dave_dms", linkKarma: 120, commentKarma: 3400, suspended: false };

/**
 * The desktop worker's side of `social.reddit.browser`, in memory: checks each payload against
 * the shared schema (as the worker does) and answers as old.reddit.com would through the PC's
 * signed-in window.
 */
function fakePc(state: { online?: boolean; signedIn?: boolean; json?: unknown; inbox?: Record<string, unknown>[] } = {}) {
  const s = { online: true, signedIn: true, inbox: [] as Record<string, unknown>[], ...state };
  const jobs: { payload: RedditBrowserPayload; options: BrowserJobOptions }[] = [];
  const comments: Record<string, string>[] = [];
  const posts: Record<string, string>[] = [];
  const messages: Record<string, string>[] = [];
  const answer = (data: unknown, status = 200): RedditBrowserResult => ({ ok: true, user, status, data });
  const browserJobs: BrowserJobs = {
    async run(kind, raw, options) {
      expect(kind).toBe("social.reddit.browser");
      if (!s.online) throw new PcOfflineError();
      const payload = RedditBrowserPayload.parse(raw);
      jobs.push({ payload, options });
      if (!s.signedIn) return { ok: false, code: "USER_REQUIRED", message: "not signed in" };
      if (payload.op === "whoami" || payload.op === "login") return { ok: true, user, status: 200 };
      if (s.json && (payload.op === "comment" || payload.op === "submit" || payload.op === "compose")) return answer(s.json);
      switch (payload.op) {
        case "comment": {
          comments.push(payload.form);
          const id = `c${comments.length}`;
          return answer({ json: { errors: [], data: { things: [{ kind: "t1", data: { id, name: `t1_${id}`, permalink: `/r/hobbycnc/comments/abc12/x/${id}/` } }] } } });
        }
        case "submit":
          posts.push(payload.form);
          return answer({ json: { errors: [], data: { url: `https://old.reddit.com/r/${payload.form.sr}/comments/new1/title/`, id: "new1", name: "t3_new1" } } });
        case "compose":
          messages.push(payload.form);
          return answer({ json: { errors: [] } });
        case "sent":
          return answer({ kind: "Listing", data: { children: [{ kind: "t4", data: { name: "t4_sent1", id: "sent1", dest: messages.at(-1)?.to } }] } });
        case "info":
          return answer({ kind: "Listing", data: { children: [{ kind: "t3", data: { name: "t3_abc12", selftext: "Which collets?", title: "Collets" } }] } });
        case "inbox": {
          const before = payload.query.before;
          const idx = before ? s.inbox.findIndex((m) => m.name === before) : s.inbox.length;
          const rows = before ? (idx < 0 ? [] : s.inbox.slice(0, idx)) : s.inbox;
          return answer({ kind: "Listing", data: { children: rows.slice(0, Number(payload.query.limit ?? 25)).map((data) => ({ kind: "t1", data })) } });
        }
      }
    },
  };
  return { browserJobs, jobs, comments, posts, messages, state: s };
}

function context(at = "2026-11-09T12:00:00Z") {
  const clock = { now: new Date(at) };
  const ctx: AdapterContext = { fetch: (() => Promise.reject(new Error("browser mode must not fetch from the server"))) as typeof fetch, log: { info: () => {}, error: () => {} }, now: () => clock.now };
  return { ctx, clock };
}

const target = (id = "t3_abc12") => ({ platform: "reddit" as const, kind: "comment" as const, id, subreddit: "hobbycnc" });

describe("Reddit browser credentials", () => {
  it("needs only the PC (or any), is paced like a session account, and isn't mistaken for one", () => {
    expect(RedditCredentials.safeParse({ browserNode: "any" }).success).toBe(true);
    expect(isRedditBrowserAccount(account())).toBe(true);
    expect(isRedditSessionAccount(account())).toBe(false);
    expect(() => validateSocialCredentials([account()], { reddit: createRedditAdapter() })).not.toThrow();
    expect(pacingFor(account(), createRedditAdapter())).toEqual({ minGapMs: 10 * 60_000, dailyCap: 8 });
    expect(createRedditAdapter().inbound!.pollIntervalFor!(account())).toBe(600);
  });
});

describe("Reddit adapter in browser mode", () => {
  it("replies through a job on the named PC, with exactly the form session mode sends, and never fetches from the server", async () => {
    const pc = fakePc();
    const { ctx } = context();
    const res = await createRedditAdapter({ browserJobs: pc.browserJobs }).reply(account(), target(), "ER11 is the one you want.", ctx);
    expect(res).toEqual({ id: "t1_c1", url: "https://www.reddit.com/r/hobbycnc/comments/abc12/x/c1/" });
    expect(pc.jobs).toEqual([
      { payload: { op: "comment", form: { thing_id: "t3_abc12", text: "ER11 is the one you want." }, username: "dave_dms" }, options: expect.objectContaining({ node: "studio-pc", once: true, timeoutMs: 300_000 }) },
    ]);
  });

  it("uses any PC when the account says any", async () => {
    const pc = fakePc();
    await createRedditAdapter({ browserJobs: pc.browserJobs }).reply(account({ credentials: { browserNode: "any" } }), target(), "hi", context().ctx);
    expect(pc.jobs[0]!.options.node).toBeUndefined();
  });

  it("posts a link with its text as the first comment, and sends a DM with its id looked up", async () => {
    const pc = fakePc();
    const adapter = createRedditAdapter({ browserJobs: pc.browserJobs });
    const { ctx } = context();
    const post = await adapter.publish(account(), { text: "Made on a 3018.", link: "https://example.com/collets", title: "ER11 collet guide", target: "r/hobbycnc" }, ctx);
    expect(post).toEqual({ id: "t3_new1", url: "https://www.reddit.com/r/hobbycnc/comments/new1/title/" });
    expect(pc.posts[0]).toMatchObject({ sr: "hobbycnc", kind: "link", url: "https://example.com/collets", title: "ER11 collet guide", sendreplies: "true" });
    expect(pc.comments).toEqual([{ thing_id: "t3_new1", text: "Made on a 3018." }]);

    const dm = await adapter.sendDm!(account(), "u/maker1", "Thanks!", ctx);
    expect(dm).toEqual({ id: "t4_sent1", url: "https://www.reddit.com/message/messages/sent1" });
    expect(pc.messages).toEqual([{ to: "maker1", subject: "Message from u/dave_dms", text: "Thanks!" }]);
    expect(pc.jobs.map((j) => [j.payload.op, j.options.once])).toEqual([["submit", true], ["comment", true], ["compose", true], ["sent", false]]);
  });

  it("maps a signed-out window, Reddit's own errors and an offline PC to the errors session mode gives", async () => {
    const { ctx } = context();
    const signedOut = fakePc({ signedIn: false });
    const err = await createRedditAdapter({ browserJobs: signedOut.browserJobs }).reply(account(), target(), "x", ctx).catch((e) => e);
    expect(err).toBeInstanceOf(RedditBrowserSignedOutError);
    expect(err).toMatchObject({ reconnect: true, codes: ["USER_REQUIRED"] });
    expect(err.message).toMatch(/Devices page, press Sign in to Reddit/);

    const limited = fakePc({ json: { json: { errors: [["RATELIMIT", "you are doing that too much. try again in 9 minutes.", "ratelimit"]] } } });
    await expect(createRedditAdapter({ browserJobs: limited.browserJobs }).reply(account(), target(), "x", ctx)).rejects.toMatchObject({ codes: ["RATELIMIT"] });
    const locked = fakePc({ json: { json: { errors: [["THREAD_LOCKED", "that thread is locked", "parent"]] } } });
    await expect(createRedditAdapter({ browserJobs: locked.browserJobs }).reply(account(), target(), "x", ctx)).rejects.toThrow(/locked or archived/);

    const off = fakePc({ online: false });
    await expect(createRedditAdapter({ browserJobs: off.browserJobs }).reply(account(), target(), "x", ctx)).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/isn't connected \(Devices page\)/) });
    await expect(createRedditAdapter().reply(account(), target(), "x", ctx)).rejects.toThrow(/isn't available on this server/);
  });

  it("rejects a result it can't read instead of guessing it went out", async () => {
    const odd: BrowserJobs = { run: async () => ({ posted: true }) };
    await expect(createRedditAdapter({ browserJobs: odd }).reply(account(), target(), "x", context().ctx)).rejects.toThrow(/couldn't read; check Reddit before sending it again/);
  });

  it("polls the inbox through the PC, by cursor", async () => {
    const msg = (n: number, created: number) => ({ name: `t1_m${n}`, id: `m${n}`, author: "maker1", body: `reply ${n}`, created_utc: created, subreddit: "hobbycnc", type: "comment_reply", parent_id: "t3_abc12", context: "/r/hobbycnc/comments/abc12/x/m/?context=3", was_comment: true });
    const pc = fakePc({ inbox: [msg(1, 1_762_689_000)] });
    const adapter = createRedditAdapter({ browserJobs: pc.browserJobs });
    const { ctx } = context();
    const first = await adapter.inbound!.poll!(account(), null, ctx);
    expect(first.items).toEqual([]);
    pc.state.inbox.unshift(msg(2, 1_762_690_000));
    const next = await adapter.inbound!.poll!(account(), first.cursor, ctx);
    expect(next.items.map((i) => [i.id, i.kind, i.text, i.context?.parentText])).toEqual([["t1_m2", "reply", "reply 2", "Which collets?"]]);
    expect(pc.jobs.every((j) => !j.options.once)).toBe(true);
    expect(pc.jobs.map((j) => j.payload.op)).toEqual(["inbox", "inbox", "info"]);
  });

  it("answers the Accounts page's Test with who the window is signed in as", async () => {
    const pc = fakePc();
    expect(await redditBrowserWhoami(pc.browserJobs, { browserNode: "Studio PC", username: "dave_dms" }, context().ctx)).toEqual(user);
    expect(pc.jobs[0]).toMatchObject({ payload: { op: "whoami", username: "dave_dms" }, options: { node: "Studio PC", once: false } });
  });
});

describe("browser-mode submissions while the PC is off", () => {
  const quiet = { info: () => {}, error: () => {} };
  function setup() {
    const pc = fakePc({ online: false });
    const { clock } = context();
    const store = new MemorySubmissionStore();
    const adapters = { reddit: createRedditAdapter({ browserJobs: pc.browserJobs }) };
    const accounts = [account()];
    const waiting: string[] = [];
    const failures: string[] = [];
    const executors = createSocialExecutors(accounts, { adapters, now: () => clock.now, submissions: store, logger: quiet, onWaiting: (a, m) => void waiting.push(`${a.id}: ${m}`) });
    const drain = () =>
      sendDueSubmissions({
        store,
        accounts,
        adapters,
        send: sendQueuedSubmission,
        now: () => clock.now,
        logger: quiet,
        onFailure: async (e: OutboxEntry, error) => void failures.push(`${e.id}: ${error}`),
        onWaiting: async (e, error) => void waiting.push(`${e.id}: ${error}`),
      });
    const tick = (minutes: number) => (clock.now = new Date(clock.now.getTime() + minutes * 60_000));
    return { pc, store, executors, drain, tick, waiting, failures };
  }

  it("keeps an approved reply queued until the PC is back, then sends it once", async () => {
    const t = setup();
    const res = (await t.executors["social.reply"].execute({ accountId: "dms-reddit", target: target(), text: "one" }, {} as never)) as Record<string, string>;
    expect(res).toMatchObject({ status: "scheduled", sendAt: "2026-11-09T12:05:00.000Z", reason: expect.stringMatching(/^waiting for the PC: .*isn't connected/) });
    expect(t.waiting).toEqual([expect.stringMatching(/^dms-reddit: /)]);
    expect(t.store.outbox).toEqual([expect.objectContaining({ status: "queued", actionType: "social.reply" })]);

    // Still off at its slot: back in the queue, not failed.
    t.tick(5);
    expect(await t.drain()).toEqual({ sent: 0, failed: 0, waiting: 1 });
    expect(t.store.outbox[0]).toMatchObject({ status: "queued", notBefore: "2026-11-09T12:10:00.000Z" });
    expect(t.failures).toEqual([]);

    // The PC is on again.
    t.pc.state.online = true;
    t.tick(5);
    expect(await t.drain()).toEqual({ sent: 1, failed: 0, waiting: 0 });
    expect(await t.drain()).toEqual({ sent: 0, failed: 0, waiting: 0 });
    expect(t.pc.comments).toEqual([{ thing_id: "t3_abc12", text: "one" }]);
    expect(t.store.outbox[0]).toMatchObject({ status: "sent", result: { ok: true, id: "t1_c1" } });
  });

  it("still fails, and doesn't retry, what Reddit itself refused", async () => {
    const t = setup();
    t.pc.state.online = true;
    t.pc.state.signedIn = false;
    await expect(t.executors["social.reply"].execute({ accountId: "dms-reddit", target: target(), text: "one" }, {} as never)).rejects.toThrow(/isn't signed in/);
    expect(t.store.outbox).toEqual([]);
  });
});
