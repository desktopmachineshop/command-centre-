import { RedditPcUnavailable, RedditReader, RedditReadError } from "@cc/research";
import { type BrowserJobs, PcOfflineError } from "@cc/social";
import { describe, expect, it } from "vitest";
import { redditPcRead } from "../src/reddit-browser";

const user = { name: "dave_dms", linkKarma: 1, commentKarma: 2, suspended: false };
/** A PC that answers each read job with `answer(payload)`, recording what it was asked. */
function pc(answer: (payload: { op: string; path?: string; query?: Record<string, string> }) => unknown) {
  const jobs: { payload: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  const run: BrowserJobs["run"] = async (_kind, payload, options) => {
    jobs.push({ payload: payload as Record<string, unknown>, options: options as unknown as Record<string, unknown> });
    return answer(payload as { op: string; path?: string; query?: Record<string, string> });
  };
  return { jobs, run };
}
const listing = { kind: "Listing", data: { children: [{ kind: "t3", data: { name: "t3_p1", title: "First cuts" } }] } };

describe("reading Reddit through Dave's PC", () => {
  it("asks the PC for one listing, as the account's user, and hands back Reddit's JSON", async () => {
    const studio = pc(() => ({ ok: true, user, status: 200, data: listing }));
    const read = redditPcRead(studio, { node: "studio-pc", username: "dave_dms" });
    expect(await read("/r/hobbycnc/new", { limit: "5" })).toEqual(listing);
    expect(studio.jobs).toEqual([{ payload: { op: "read", path: "/r/hobbycnc/new", query: { limit: "5" }, username: "dave_dms" }, options: { node: "studio-pc", timeoutMs: 45_000, once: false } }]);
  });

  it("says what Reddit said, and that the PC can't when it can't", async () => {
    const say = (result: unknown) => redditPcRead(pc(() => result), {})("/r/x/about", {});
    await expect(say({ ok: true, user, status: 404, data: { error: 404 } })).rejects.toThrow(RedditReadError);
    await expect(say({ ok: true, user, status: 403, data: { reason: "private" } })).rejects.toThrow(/the subreddit is private/);
    await expect(say({ ok: false, code: "RATELIMIT", message: "slow down", retryAfterSec: 30 })).rejects.toThrow(/rate limiting the PC's session; it asks for about 30s/);
    // Not Reddit's answer about the thing asked for: the PC can't right now.
    await expect(say({ ok: false, code: "USER_REQUIRED", message: "The PC's Reddit window isn't signed in to Reddit" })).rejects.toThrow(RedditPcUnavailable);
    await expect(say({ ok: false, code: "BLOCKED", message: "Reddit answered with a page" })).rejects.toThrow(RedditPcUnavailable);
    await expect(say({ nonsense: true })).rejects.toThrow(RedditPcUnavailable);
    const off: BrowserJobs = { run: async () => Promise.reject(new PcOfflineError()) };
    await expect(redditPcRead(off, {})("/search", { q: "x" })).rejects.toThrow(RedditPcUnavailable);
  });
});

describe("the read tools' reader with a PC connected", () => {
  const html = () => new Response("<html><title>Blocked</title></html>", { status: 403, headers: { "content-type": "text/html" } });

  it("reads and searches through the PC, without asking Reddit from the server", async () => {
    const studio = pc((p) => ({ ok: true, user, status: 200, data: { ...listing, asked: p.path, q: p.query?.q ?? null } }));
    const fromServer: string[] = [];
    const reader = new RedditReader({
      browser: () => redditPcRead(studio, { username: "dave_dms" }),
      fetch: async (input) => {
        fromServer.push(String(input));
        return html();
      },
      sleep: async () => {},
    });
    expect(reader.signedIn).toBe(true);
    expect(await reader.get("/r/hobbycnc/new", { limit: 5 })).toMatchObject({ asked: "/r/hobbycnc/new" });
    expect(await reader.get("/search", { q: "spindle runout", sort: "new" })).toMatchObject({ asked: "/search", q: "spindle runout" });
    expect(studio.jobs.map((j) => j.payload.path)).toEqual(["/r/hobbycnc/new", "/search"]);
    expect(fromServer).toEqual([]);
    // Asked again straight away: answered from the cache, not by another job.
    await reader.get("/r/hobbycnc/new", { limit: 5 });
    expect(studio.jobs).toHaveLength(2);
  });

  it("falls back to reading from the server when the PC is off", async () => {
    const off: BrowserJobs = { run: async () => Promise.reject(new PcOfflineError()) };
    const fromServer: string[] = [];
    const reader = new RedditReader({
      browser: () => redditPcRead(off, {}),
      fetch: async (input) => {
        fromServer.push(new URL(String(input)).pathname);
        return new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } });
      },
      sleep: async () => {},
    });
    expect(await reader.get("/r/hobbycnc/new", {})).toEqual(listing);
    expect(fromServer).toEqual(["/r/hobbycnc/new.json"]);
  });

  it("gives Reddit's own answer (not found) without trying another way", async () => {
    const studio = pc(() => ({ ok: true, user, status: 404, data: { error: 404 } }));
    const fromServer: string[] = [];
    const reader = new RedditReader({ browser: () => redditPcRead(studio, {}), fetch: async (input) => (fromServer.push(String(input)), html()), sleep: async () => {} });
    await expect(reader.get("/comments/zzzz9", {})).rejects.toThrow(/Reddit has nothing there/);
    expect(fromServer).toEqual([]);
  });
});
