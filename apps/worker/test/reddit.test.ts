import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@cc/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HandlerRegistry, type JobContext, RedditBrowser, redditBrowserHandler } from "../src";

const CHROMIUM = process.env.CC_CHROMIUM_BIN ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null);
const SESSION = "1234567%2C2026-11-01T10-00-00%2Cabcdef0123456789";
const MODHASH = "modhash-abc123";

/**
 * old.reddit.com's form protocol over real HTTP (as packages/social/test/reddit-session.test.ts
 * fakes it for the server): the login page signs the browser in (standing in for Dave typing his
 * password), /api/me.json gives the modhash to a signed-in cookie, and POSTs need the cookie and
 * the modhash. It records what the browser sent.
 */
function fakeOldReddit() {
  const state = {
    signedIn: false,
    user: "dave_dms",
    blocked: false,
    loginRedirect: false,
    /** Off: the login page opens but nobody signs in. */
    loginWorks: true,
    staleModhashOnce: false,
    requests: [] as { method: string; path: string; cookie: string; agent: string; modhash?: string; form?: Record<string, string> }[],
    inFlight: 0,
    maxInFlight: 0,
  };
  const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
  const server = createServer(async (req, res) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const url = new URL(req.url!, "http://x");
    const cookie = req.headers.cookie ?? "";
    const form = req.method === "POST" ? Object.fromEntries(new URLSearchParams(await body(req))) : undefined;
    // Each request takes a moment, so overlapping jobs would show.
    await new Promise((r) => setTimeout(r, 20));
    state.inFlight--;
    if (url.pathname !== "/favicon.ico") state.requests.push({ method: req.method!, path: url.pathname, cookie, agent: String(req.headers["user-agent"] ?? ""), modhash: req.headers["x-modhash"] as string | undefined, form });
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (state.blocked) {
      res.writeHead(403, { "content-type": "text/html" });
      return res.end("<html><head><title>Blocked</title></head><body>whoa there, pardner!</body></html>");
    }
    if (url.pathname === "/login" && state.loginWorks) {
      // Dave signs in in the window: Reddit sets its session cookie.
      state.signedIn = true;
      res.writeHead(200, { "content-type": "text/html", "set-cookie": `reddit_session=${SESSION}; Path=/; Max-Age=86400; HttpOnly` });
      return res.end("<html><head><title>reddit.com: log in</title></head><body>Welcome back</body></html>");
    }
    const authed = state.signedIn && cookie.includes(`reddit_session=${SESSION}`);
    if (!authed && state.loginRedirect) {
      res.writeHead(302, { location: `/login/?dest=${encodeURIComponent(url.pathname)}` });
      return res.end();
    }
    if (url.pathname === "/api/me.json") return json(authed ? { kind: "t2", data: { name: state.user, modhash: MODHASH, link_karma: 120, comment_karma: 3400 } } : {});
    if (req.method === "POST") {
      if (!authed) return json({ json: { errors: [["USER_REQUIRED", "Please log in to do that.", null]] } });
      if (state.staleModhashOnce) {
        state.staleModhashOnce = false;
        return json({ message: "Forbidden", error: 403 }, 403);
      }
      if (form?.uh !== MODHASH || req.headers["x-modhash"] !== MODHASH || form?.api_type !== "json") return json({ message: "Forbidden", error: 403 }, 403);
      if (url.pathname === "/api/comment") {
        const id = `c${state.requests.filter((r) => r.path === "/api/comment").length}`;
        return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id, name: `t1_${id}`, permalink: `/r/hobbycnc/comments/abc12/x/${id}/` } }] } } });
      }
      if (url.pathname === "/api/submit") return json({ json: { errors: [], data: { url: "http://old/r/test/comments/new1/t/", id: "new1", name: "t3_new1" } } });
      if (url.pathname === "/api/compose") return json({ json: { errors: [] } });
    }
    if (url.pathname === "/message/inbox.json") {
      if (!authed) return json({ error: 403 }, 403);
      return json({ kind: "Listing", data: { children: [{ kind: "t1", data: { name: "t1_m1", body: "hello", limit: url.searchParams.get("limit") } }] } });
    }
    return json({ error: 404 }, 404);
  });
  return { server, state };
}

function job(payload: Record<string, unknown>): Job {
  const now = new Date().toISOString();
  return { id: "job-1", kind: "social.reddit.browser", requires: ["browser"], payload, status: "assigned", nodeId: "n", progress: null, result: null, createdAt: now, updatedAt: now };
}
const context = (payload: Record<string, unknown>): JobContext => ({ job: job(payload), dir: tmpdir(), signal: new AbortController().signal, progress: () => {} });

describe("social.reddit.browser payloads", () => {
  it("only takes the fixed ops, and never the modhash or a path from the server", async () => {
    const registry = new HandlerRegistry().register(redditBrowserHandler({ chromiumBin: null, profileDir: tmpdir() }));
    await expect(registry.run(context({ op: "vote", dir: 1, id: "t3_abc" }))).rejects.toThrow(/Invalid social.reddit.browser payload/);
    await expect(registry.run(context({ op: "comment", form: { thing_id: "t3_a", text: "x", uh: "mine" } }))).rejects.toThrow(/uh and api_type are set by the worker/);
    await expect(registry.run(context({ op: "comment", path: "/api/vote", form: { thing_id: "t3_a", text: "x" } }))).resolves.toMatchObject({ ok: false, code: "BROWSER", message: expect.stringMatching(/No Chrome or Edge/) });
  });
});

describe.skipIf(!CHROMIUM)("posting to Reddit from this PC's browser", () => {
  const fake = fakeOldReddit();
  let base = "";
  let reddit: RedditBrowser;
  const profileDir = mkdtempSync(join(tmpdir(), "cc-reddit-profile-"));
  // Headless only because the test machine has no display; on Dave's PC the window is visible.
  const make = (over: Partial<ConstructorParameters<typeof RedditBrowser>[0]> = {}) =>
    new RedditBrowser({ chromiumBin: CHROMIUM, profileDir, baseUrl: base, headless: true, loginPollMs: 50, load: () => import("playwright-core"), ...over });

  beforeAll(async () => {
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    reddit = make();
  });
  afterEach(() => {
    fake.state.requests = [];
    fake.state.blocked = false;
  });
  afterAll(async () => {
    await reddit?.close();
    fake.server.close();
  });

  it("says the window isn't signed in before Dave signs in, and does nothing else", async () => {
    expect(await reddit.run({ op: "comment", form: { thing_id: "t3_abc12", text: "hi" } })).toMatchObject({ ok: false, code: "USER_REQUIRED" });
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/me.json"]);
  });

  it("signs in through the login page in the profile's window, and the profile keeps it", async () => {
    const result = await reddit.run({ op: "login", timeoutSec: 30 });
    expect(result).toEqual({ ok: true, status: 200, user: { name: "dave_dms", linkKarma: 120, commentKarma: 3400, suspended: false } });
    expect(fake.state.requests[0]).toMatchObject({ method: "GET", path: "/login" });
    // A new window on the same profile (a restarted worker) is still signed in.
    await reddit.close();
    reddit = make();
    expect(await reddit.run({ op: "whoami", username: "Dave_DMS" })).toMatchObject({ ok: true, user: { name: "dave_dms" } });
  });

  it("replies with an in-page request carrying the browser's own cookies, User-Agent and the modhash", async () => {
    const result = await reddit.run({ op: "comment", form: { thing_id: "t3_abc12", text: "ER11 is the one you want." }, username: "dave_dms" });
    expect(result).toMatchObject({ ok: true, status: 200, data: { json: { errors: [], data: { things: [{ data: { name: "t1_c1" } }] } } } });
    const post = fake.state.requests.find((r) => r.method === "POST")!;
    expect(post).toMatchObject({ path: "/api/comment", modhash: MODHASH, form: { api_type: "json", thing_id: "t3_abc12", text: "ER11 is the one you want.", uh: MODHASH } });
    expect(post.cookie).toContain(`reddit_session=${SESSION}`);
    expect(post.agent).toMatch(/Chrome\//); // the browser's own, nothing made up
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/me.json", "POST /api/comment"]);
  });

  it("submits, composes and reads the inbox through the fixed paths", async () => {
    expect(await reddit.run({ op: "submit", form: { sr: "test", title: "t", kind: "self", text: "body" } })).toMatchObject({ ok: true, data: { json: { data: { name: "t3_new1" } } } });
    expect(await reddit.run({ op: "compose", form: { to: "maker1", subject: "s", text: "t" } })).toMatchObject({ ok: true, data: { json: { errors: [] } } });
    expect(await reddit.run({ op: "inbox", query: { limit: "1", mark: "false" } })).toMatchObject({ ok: true, data: { data: { children: [{ data: { name: "t1_m1", limit: "1" } }] } } });
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/me.json", "POST /api/submit", "GET /api/me.json", "POST /api/compose", "GET /api/me.json", "GET /message/inbox.json"]);
  });

  it("asks for a fresh modhash once when Reddit refuses the first, then sends", async () => {
    fake.state.staleModhashOnce = true;
    expect(await reddit.run({ op: "comment", form: { thing_id: "t3_abc12", text: "again" } })).toMatchObject({ ok: true, status: 200 });
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/me.json", "POST /api/comment", "GET /api/me.json", "POST /api/comment"]);
  });

  it("refuses to post as someone else than the account the job is for", async () => {
    expect(await reddit.run({ op: "comment", form: { thing_id: "t3_abc12", text: "x" }, username: "other_account" })).toMatchObject({ ok: false, code: "WRONG_USER", message: expect.stringMatching(/signed in as u\/dave_dms, not u\/other_account/) });
    expect(fake.state.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("fails with what Reddit said when it blocks, and solves nothing", async () => {
    fake.state.blocked = true;
    expect(await reddit.run({ op: "comment", form: { thing_id: "t3_abc12", text: "x" } })).toMatchObject({ ok: false, code: "BLOCKED", status: 403, message: expect.stringMatching(/refused the session check \(HTTP 403\).*blocking this PC/) });
  });

  it("runs one job at a time", async () => {
    fake.state.maxInFlight = 0;
    await Promise.all([1, 2, 3].map((n) => reddit.run({ op: "comment", form: { thing_id: "t3_abc12", text: `n${n}` } })));
    expect(fake.state.maxInFlight).toBe(1);
    expect(fake.state.requests.filter((r) => r.method === "POST").map((r) => r.form!.text)).toEqual(["n1", "n2", "n3"]);
  });

  it("reads a redirect to the login page as signed out, and gives up waiting for a sign-in in time", async () => {
    fake.state.signedIn = false;
    fake.state.loginRedirect = true;
    expect(await reddit.run({ op: "whoami" })).toMatchObject({ ok: false, code: "USER_REQUIRED" });
    fake.state.loginRedirect = false;
    fake.state.loginWorks = false;
    try {
      expect(await reddit.run({ op: "login", timeoutSec: 10 })).toMatchObject({ ok: false, code: "TIMEOUT", message: expect.stringMatching(/Nobody signed in/) });
    } finally {
      fake.state.loginWorks = true;
      fake.state.signedIn = true;
    }
  }, 20_000);

  it("closes the window after a quiet spell and opens it again for the next job", async () => {
    // A profile of its own: one window per profile.
    const opened: string[] = [];
    const quick = make({ idleCloseMs: 50, profileDir: mkdtempSync(join(tmpdir(), "cc-reddit-profile-")), log: (l) => opened.push(l) });
    try {
      expect(await quick.run({ op: "whoami" })).toMatchObject({ ok: false, code: "USER_REQUIRED" });
      await new Promise((r) => setTimeout(r, 300));
      expect(await quick.run({ op: "whoami" })).toMatchObject({ ok: false, code: "USER_REQUIRED" });
      expect(opened.filter((l) => l.includes("opened the Reddit window"))).toHaveLength(2);
    } finally {
      await quick.close();
    }
  });
});
