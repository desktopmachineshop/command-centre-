import { describe, expect, it, vi } from "vitest";
import type { AdapterContext, SocialAccount } from "../src";
import { createRedditAdapter } from "../src/adapters/reddit";

const unexpected = (): never => {
  throw new Error("expected the call to fail");
};

const SECRET = "client-SECRET-xyz";
const PASSWORD = "hunter2-PASSWORD";
const TOKEN = "access-TOKEN-1";

const account = (options: Record<string, unknown> = {}): SocialAccount => ({
  id: "3dp-reddit",
  platform: "reddit",
  vertical: "3dpandme",
  inbound: true,
  credentials: {
    clientId: "cid123",
    clientSecret: SECRET,
    username: "3dpandme",
    password: PASSWORD,
    userAgent: "server:com.3dpandme.commandcentre:v0.1.0 (by /u/3dpandme)",
  },
  options,
});

type Call = { url: string; method: string; headers: Record<string, string>; form: URLSearchParams | null };

function mockFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      form: init?.body ? new URLSearchParams(String(init.body)) : null,
    };
    calls.push(call);
    return handler(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const tokenResponse = () => json({ access_token: TOKEN, token_type: "bearer", expires_in: 3600, scope: "*" });

/** Routes: token grant plus a map of "METHOD path" -> response factory. */
function api(routes: Record<string, (call: Call) => Response>) {
  return mockFetch((call) => {
    if (call.url === "https://www.reddit.com/api/v1/access_token") return tokenResponse();
    const u = new URL(call.url);
    const route = routes[`${call.method} ${u.pathname}`];
    if (!route) throw new Error(`unexpected ${call.method} ${call.url}`);
    return route(call);
  });
}

function makeCtx(fetch: typeof globalThis.fetch, now = { t: Date.parse("2026-10-23T12:00:00Z") }) {
  const errors: string[] = [];
  const ctx: AdapterContext = {
    fetch,
    now: () => new Date(now.t),
    log: { info: () => {}, error: (m, e) => errors.push(`${m} ${e instanceof Error ? e.message : ""}`) },
  };
  return { ctx, now, errors };
}

const submitted = (id = "abc12") => json({ json: { errors: [], data: { id, name: `t3_${id}`, url: `https://www.reddit.com/r/hobbycnc/comments/${id}/my_post/` } } });

describe("reddit auth", () => {
  it("gets a token with the password grant, caches it and refreshes before expiry", async () => {
    const { fetch, calls } = api({ "POST /api/submit": () => submitted() });
    const { ctx, now } = makeCtx(fetch);
    const adapter = createRedditAdapter();
    const post = { text: "body", title: "Title", target: "hobbycnc" };

    await adapter.publish(account(), post, ctx);
    await adapter.publish(account(), post, ctx);
    const grants = () => calls.filter((c) => c.url.endsWith("/access_token"));
    expect(grants()).toHaveLength(1);
    const grant = grants()[0]!;
    expect(grant.method).toBe("POST");
    expect(grant.headers.Authorization).toBe(`Basic ${Buffer.from(`cid123:${SECRET}`).toString("base64")}`);
    expect(grant.headers["User-Agent"]).toBe("server:com.3dpandme.commandcentre:v0.1.0 (by /u/3dpandme)");
    expect(Object.fromEntries(grant.form!)).toEqual({ grant_type: "password", username: "3dpandme", password: PASSWORD });
    expect(calls[1]!.headers.Authorization).toBe(`bearer ${TOKEN}`);
    expect(calls[1]!.url.startsWith("https://oauth.reddit.com/")).toBe(true);

    now.t += 56 * 60_000; // inside the 5-minute refresh window
    await adapter.publish(account(), post, ctx);
    expect(grants()).toHaveLength(2);
  });

  it("re-grants once on a 401", async () => {
    let first = true;
    const { fetch, calls } = api({
      "POST /api/submit": () => {
        if (first) {
          first = false;
          return json({ message: "Unauthorized", error: 401 }, 401);
        }
        return submitted();
      },
    });
    await createRedditAdapter().publish(account(), { text: "b", title: "t", target: "hobbycnc" }, makeCtx(fetch).ctx);
    expect(calls.filter((c) => c.url.endsWith("/access_token"))).toHaveLength(2);
  });

  it("explains a failed login without leaking the secret or password", async () => {
    const { fetch } = mockFetch(() => json({ error: "invalid_grant" }));
    const err = await createRedditAdapter()
      .publish(account(), { text: "b", title: "t", target: "hobbycnc" }, makeCtx(fetch).ctx)
      .then(unexpected, (e: Error) => e);
    expect(err.message).toContain("invalid_grant");
    expect(err.message).toContain("two-factor");
    for (const s of [SECRET, PASSWORD, TOKEN]) expect(err.message).not.toContain(s);
  });

  it("rejects credentials with a malformed User-Agent", () => {
    const adapter = createRedditAdapter();
    expect(adapter.credentials.safeParse({ ...account().credentials, userAgent: "python-requests" }).success).toBe(false);
    expect(adapter.credentials.safeParse(account().credentials).success).toBe(true);
  });
});

describe("reddit publish, reply, DM", () => {
  it("submits a self post with flair and returns the permalink", async () => {
    const { fetch, calls } = api({ "POST /api/submit": () => submitted() });
    const res = await createRedditAdapter().publish(
      account(),
      { text: "Here's my enclosure build", title: "Enclosure for my 3018", target: "r/hobbycnc", options: { flairId: "flair-uuid" } },
      makeCtx(fetch).ctx,
    );
    expect(res).toEqual({ id: "t3_abc12", url: "https://www.reddit.com/r/hobbycnc/comments/abc12/my_post/" });
    const form = Object.fromEntries(calls[1]!.form!);
    expect(form).toEqual({
      api_type: "json",
      sr: "hobbycnc",
      title: "Enclosure for my 3018",
      kind: "self",
      text: "Here's my enclosure build",
      flair_id: "flair-uuid",
      sendreplies: "true",
    });
  });

  it("submits a link post and adds the text as the first comment", async () => {
    const { fetch, calls } = api({
      "POST /api/submit": () => submitted("lnk1"),
      "POST /api/comment": () => json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "c1", name: "t1_c1", permalink: "/r/3Dprinting/comments/lnk1/x/c1/" } }] } } }),
    });
    const res = await createRedditAdapter().publish(
      account(),
      { text: "Submission statement", title: "Video: printing PETG", target: "3Dprinting", link: "https://youtube.com/watch?v=1" },
      makeCtx(fetch).ctx,
    );
    expect(res.id).toBe("t3_lnk1");
    expect(Object.fromEntries(calls[1]!.form!)).toMatchObject({ kind: "link", url: "https://youtube.com/watch?v=1", sr: "3Dprinting" });
    expect(calls[1]!.form!.has("text")).toBe(false);
    expect(Object.fromEntries(calls[2]!.form!)).toMatchObject({ thing_id: "t3_lnk1", text: "Submission statement" });
  });

  it("posts an image as a link to its public URL", async () => {
    const { fetch, calls } = api({ "POST /api/submit": () => submitted() });
    await createRedditAdapter().publish(
      account(),
      { text: "", title: "Fresh print", target: "3Dprinting", media: [{ url: "https://media.example/p.jpg", type: "image" }] },
      makeCtx(fetch).ctx,
    );
    expect(Object.fromEntries(calls[1]!.form!)).toMatchObject({ kind: "link", url: "https://media.example/p.jpg" });
  });

  it("validates hard limits", () => {
    const v = createRedditAdapter().validate.bind(createRedditAdapter());
    expect(v(account(), { text: "x" })).toEqual(["a title is required", "a target is required"]);
    expect(v(account(), { text: "x", title: "t".repeat(301), target: "hobbycnc" })).toEqual(["title is longer than 300 characters"]);
    expect(v(account(), { text: "x".repeat(40_001), title: "t", target: "hobbycnc" })).toEqual(["text is longer than 40000 characters"]);
    expect(v(account(), { text: "", link: "https://x", title: "t", target: "hobbycnc" })).toEqual([]);
    expect(v(account(), { text: "x", title: "t", target: "not a sub!" })).toEqual(['"not a sub!" is not a valid subreddit name']);
  });

  it("replies to a comment by fullname", async () => {
    const { fetch, calls } = api({
      "POST /api/comment": () => json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "r1", name: "t1_r1", permalink: "/r/hobbycnc/comments/p/x/r1/" } }] } } }),
    });
    const res = await createRedditAdapter().reply(account(), { platform: "reddit", kind: "reply", id: "t1_parent" }, "Thanks!", makeCtx(fetch).ctx);
    expect(res).toEqual({ id: "t1_r1", url: "https://www.reddit.com/r/hobbycnc/comments/p/x/r1/" });
    expect(Object.fromEntries(calls[1]!.form!)).toEqual({ api_type: "json", thing_id: "t1_parent", text: "Thanks!" });
  });

  it("sends a DM with /api/compose and finds its id in the sent box", async () => {
    const { fetch, calls } = api({
      "POST /api/compose": () => json({ json: { errors: [] } }),
      "GET /message/sent": () => json({ data: { children: [{ kind: "t4", data: { id: "m9", name: "t4_m9", dest: "someone" } }] } }),
    });
    const res = await createRedditAdapter().sendDm!(account({ dmSubject: "About your order" }), "u/someone", "Hi there", makeCtx(fetch).ctx);
    expect(Object.fromEntries(calls[1]!.form!)).toEqual({ api_type: "json", to: "someone", subject: "About your order", text: "Hi there" });
    expect(res).toEqual({ id: "t4_m9", url: "https://www.reddit.com/message/messages/m9" });
  });
});

describe("reddit errors", () => {
  const fail = async (errors: unknown[]) => {
    const { fetch } = api({ "POST /api/submit": () => json({ json: { errors } }) });
    return createRedditAdapter()
      .publish(account(), { text: "b", title: "t", target: "hobbycnc" }, makeCtx(fetch).ctx)
      .then(unexpected, (e: Error & { codes?: string[] }) => e);
  };

  it("maps RATELIMIT", async () => {
    const err = await fail([["RATELIMIT", "Looks like you've been doing that a lot. Take a break for 9 minutes before trying again.", "ratelimit"]]);
    expect(err.message).toMatch(/rate limited by Reddit.*9 minutes/);
    expect(err.codes).toEqual(["RATELIMIT"]);
  });

  it("maps SUBREDDIT_NOEXIST and flair required", async () => {
    expect((await fail([["SUBREDDIT_NOEXIST", "that subreddit doesn't exist", "sr"]])).message).toContain("subreddit doesn't exist");
    expect((await fail([["SUBMIT_VALIDATION_FLAIR_REQUIRED", "Your post must contain post flair.", "flair"]])).message).toContain("content.options.flairId");
  });

  it("passes unknown codes through and never includes secrets", async () => {
    const err = await fail([["SOMETHING_NEW", "odd", "x"]]);
    expect(err.message).toContain("SOMETHING_NEW: odd (x)");
    for (const s of [SECRET, PASSWORD, TOKEN]) expect(err.message).not.toContain(s);
  });

  it("reports HTTP 429 with the reset time", async () => {
    const { fetch } = api({ "POST /api/submit": () => json({ message: "Too Many Requests" }, 429, { "x-ratelimit-reset": "42" }) });
    const err = await createRedditAdapter()
      .publish(account(), { text: "b", title: "t", target: "hobbycnc" }, makeCtx(fetch).ctx)
      .then(unexpected, (e: Error) => e);
    expect(err.message).toContain("resets in 42s");
  });
});

describe("reddit inbox polling", () => {
  const created = Date.parse("2026-10-23T12:00:00Z") / 1000;
  const commentReply = {
    kind: "t1",
    data: {
      id: "c2",
      name: "t1_c2",
      author: "maker42",
      body: "What feeds did you use?",
      created_utc: created + 30,
      subreddit: "hobbycnc",
      link_title: "Enclosure for my 3018",
      context: "/r/hobbycnc/comments/abc12/enclosure/c2/?context=3",
      parent_id: "t1_c1",
      type: "comment_reply",
      was_comment: true,
    },
  };
  const mention = {
    kind: "t1",
    data: {
      id: "c3",
      name: "t1_c3",
      author: "fan",
      body: "u/3dpandme made a video on this",
      created_utc: created + 60,
      subreddit: "3Dprinting",
      link_title: "Stringing help",
      context: "/r/3Dprinting/comments/zz9/stringing/c3/?context=3",
      parent_id: "t3_zz9",
      type: "username_mention",
      was_comment: true,
    },
  };
  const dm = {
    kind: "t4",
    data: { id: "m1", name: "t4_m1", author: "buyer", body: "Do you sell spoilboards?", subject: "Question", created_utc: created + 90, was_comment: false, parent_id: null },
  };

  it("establishes a cursor on the first run without replaying backlog", async () => {
    const old = { kind: "t4", data: { ...dm.data, name: "t4_old", id: "old", created_utc: created - 5000 } };
    const { fetch, calls } = api({ "GET /message/inbox": () => json({ data: { children: [old] } }) });
    const res = await createRedditAdapter().inbound!.poll!(account(), null, makeCtx(fetch).ctx);
    expect(res.items).toEqual([]);
    expect(JSON.parse(res.cursor!)).toEqual({ before: "t4_old", since: created });
    const q = new URL(calls[1]!.url).searchParams;
    expect(q.get("limit")).toBe("1");
    expect(q.get("mark")).toBe("false");
  });

  it("returns new items oldest first with context, and advances the cursor", async () => {
    const { fetch, calls } = api({
      "GET /message/inbox": () => json({ data: { children: [dm, mention, commentReply] } }), // newest first
      "GET /api/info": () =>
        json({
          data: {
            children: [
              { kind: "t1", data: { name: "t1_c1", body: "I milled it from 6mm MDF" } },
              { kind: "t3", data: { name: "t3_zz9", title: "Stringing help", selftext: "My PETG strings everywhere" } },
            ],
          },
        }),
    });
    const adapter = createRedditAdapter();
    const res = await adapter.inbound!.poll!(account(), JSON.stringify({ before: "t4_old", since: created }), makeCtx(fetch).ctx);

    const inboxQuery = new URL(calls[1]!.url).searchParams;
    expect(inboxQuery.get("before")).toBe("t4_old");
    expect(inboxQuery.get("mark")).toBe("false");
    expect(new URL(calls[2]!.url).searchParams.get("id")).toBe("t1_c1,t3_zz9");
    expect(calls.some((c) => c.url.includes("read_message"))).toBe(false);

    expect(res.items.map((i) => [i.id, i.kind])).toEqual([
      ["t1_c2", "reply"],
      ["t1_c3", "mention"],
      ["t4_m1", "dm"],
    ]);
    expect(res.items[0]).toMatchObject({
      author: { id: "maker42", handle: "u/maker42" },
      text: "What feeds did you use?",
      url: "https://www.reddit.com/r/hobbycnc/comments/abc12/enclosure/c2/",
      createdAt: new Date((created + 30) * 1000).toISOString(),
      replyTarget: { platform: "reddit", kind: "reply", id: "t1_c2", subreddit: "hobbycnc" },
      context: {
        subreddit: "hobbycnc",
        postId: "t3_abc12",
        postUrl: "https://www.reddit.com/r/hobbycnc/comments/abc12/",
        postText: "Enclosure for my 3018",
        parentText: "I milled it from 6mm MDF",
      },
    });
    expect(res.items[1]!.context?.parentText).toBe("My PETG strings everywhere");
    expect(res.items[2]).toMatchObject({ kind: "dm", context: { postText: "Subject: Question" }, replyTarget: { id: "t4_m1" } });
    expect(JSON.parse(res.cursor!)).toEqual({ before: "t4_m1", since: created + 90 });
  });

  it("keeps the cursor when nothing is new", async () => {
    const cursor = JSON.stringify({ before: "t4_m1", since: created + 90 });
    const { fetch } = api({
      "GET /message/inbox": (c) => json({ data: { children: new URL(c.url).searchParams.get("before") ? [] : [dm] } }),
    });
    const res = await createRedditAdapter().inbound!.poll!(account(), cursor, makeCtx(fetch).ctx);
    expect(res).toEqual({ items: [], cursor });
  });

  it("resyncs by time when the cursor item has gone from the inbox", async () => {
    const { fetch } = api({
      "GET /message/inbox": (c) => json({ data: { children: new URL(c.url).searchParams.get("before") ? [] : [dm, mention] } }),
      "GET /api/info": () => json({ data: { children: [] } }),
    });
    const res = await createRedditAdapter().inbound!.poll!(account(), JSON.stringify({ before: "t1_deleted", since: created + 45 }), makeCtx(fetch).ctx);
    expect(res.items.map((i) => i.id)).toEqual(["t1_c3", "t4_m1"]);
  });

  it("suggests a poll interval inside the rate limit", () => {
    const s = createRedditAdapter().inbound!.pollIntervalSeconds!;
    expect(s).toBeGreaterThanOrEqual(60);
    expect(s).toBeLessThanOrEqual(120);
  });
});
