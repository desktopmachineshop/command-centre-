import { type Job, RedditBrowserPayload, type RedditBrowserResult } from "@cc/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Peer } from "../src/hub";
import * as scheduler from "../src/scheduler";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

vi.mock("../src/scheduler", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/scheduler")>();
  return { ...m, startSystemJobs: vi.fn(m.startSystemJobs) };
});

const user = { name: "dave_dms", linkKarma: 120, commentKarma: 3400, suspended: false };

/**
 * Dave's PC as the server sees it: a connected worker with `browser` that answers each
 * `social.reddit.browser` job as apps/worker/src/handlers/reddit.ts would after asking
 * old.reddit.com (the handler itself is tested against a fake old.reddit.com in apps/worker).
 */
function fakePc(server: { workers: { handle(nodeId: string, m: never): Promise<void> } }) {
  const state = { signedIn: true, jobs: [] as Job[], comments: [] as Record<string, string>[], silent: false };
  const answer = (payload: RedditBrowserPayload): RedditBrowserResult => {
    if (!state.signedIn) return { ok: false, code: "USER_REQUIRED", message: "The PC's Reddit window isn't signed in to Reddit" };
    if (payload.op === "comment") {
      state.comments.push(payload.form);
      const id = `c${state.comments.length}`;
      return { ok: true, user, status: 200, data: { json: { errors: [], data: { things: [{ kind: "t1", data: { id, name: `t1_${id}`, permalink: `/r/hobbycnc/comments/abc12/x/${id}/` } }] } } } };
    }
    return { ok: true, user, status: 200 };
  };
  const peer: Peer = {
    send: (frame) => {
      const message = JSON.parse(frame) as { type: string; job?: Job };
      if (message.type !== "job.assign" || !message.job) return;
      const job = message.job;
      state.jobs.push(job);
      // Other work (a video capture) runs until the test finishes it; a hung PC answers nothing.
      if (job.kind !== "social.reddit.browser" || state.silent) return;
      // Answered a moment later, like a real worker over the socket.
      setTimeout(() => void server.workers.handle("studio-pc", { type: "job.complete", jobId: job.id, result: answer(RedditBrowserPayload.parse(job.payload)) } as never), 5);
    },
  };
  return { peer, state };
}

describe.skipIf(!DB_URL)("Reddit from Dave's PC (integration)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let pc: ReturnType<typeof fakePc>;
  let jobs: Parameters<typeof scheduler.startSystemJobs>[0];
  const node = { id: "studio-pc", name: "Studio PC", capabilities: ["browser" as const] };
  const reply = (text: string) => ({ vertical: "dms", taskId: null, actionType: "social.reply", summary: `Reddit r/hobbycnc: ${text}`, payload: { accountId: "dms-reddit-pc", target: { platform: "reddit", kind: "comment", id: "t3_abc12", subreddit: "hobbycnc" }, text } });
  const approve = async (text: string) => {
    const proposed = await ctx.server.actions.propose(reply(text));
    expect(proposed.status).toBe("pending"); // every Reddit post still waits for Dave
    return (await ctx.api(`/api/proposals/${proposed.id}/approve`, { method: "POST" })).body as { status: string; result: { result?: Record<string, unknown>; error?: string } };
  };
  const outbox = async () => (await ctx.api("/api/social/outbox")).body as { id: string; status: string; notBefore: string; result: unknown }[];
  const due = (id: string) => ctx.server.store.pool.query("update social_outbox set not_before = now() - interval '1 second' where id = $1", [id]);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ overrides: { redditBrowserPickupMs: 300 } });
    jobs = vi.mocked(scheduler.startSystemJobs).mock.calls[0]![0];
    pc = fakePc(ctx.server as never);
  });
  afterAll(async () => {
    await ctx?.server.stop();
  });

  it("adds a Reddit account that posts from the PC, and Test asks that PC who it's signed in as", async () => {
    const kind = (await ctx.api("/api/integrations")).body.kinds.find((k: { kind: string }) => k.kind === "reddit-browser");
    expect(kind).toMatchObject({ label: "Reddit (posts from my PC)", section: "social", multi: true, testable: true });
    expect(kind.description).toMatch(/outside Reddit's official API.*rate limited or banned/);

    const saved = await ctx.api("/api/integrations/reddit-browser/dms-reddit-pc", {
      method: "PUT",
      json: { data: { vertical: "dms", handle: "u/dave_dms", inbound: false, browserNode: "Studio PC", minGapMinutes: 0.02, dailyCap: 6 } },
    });
    expect(saved.status).toBe(200);
    const accounts = (await ctx.api("/api/social/accounts")).body as { id: string; platform: string }[];
    expect(accounts).toEqual([expect.objectContaining({ id: "dms-reddit-pc", platform: "reddit" })]);

    // The PC has never connected: Test says which PC to fix.
    const missing = await ctx.api("/api/integrations/reddit-browser/dms-reddit-pc/test", { method: "POST" });
    expect(missing.body).toMatchObject({ ok: false, message: expect.stringMatching(/no PC "Studio PC" on the Devices page/) });

    await ctx.server.workers.connect(node, pc.peer);
    const test = await ctx.api("/api/integrations/reddit-browser/dms-reddit-pc/test", { method: "POST" });
    expect(test.body).toMatchObject({ ok: true, account: "u/dave_dms", message: "Signed in to Reddit on Studio PC as u/dave_dms (3,520 karma: 120 post, 3,400 comment)" });
    expect(pc.state.jobs.at(-1)).toMatchObject({ kind: "social.reddit.browser", requires: ["browser"], targetNodeId: "studio-pc", payload: { op: "whoami", username: "dave_dms" } });
    // A read leaves nothing in the job list.
    expect(((await ctx.api("/api/jobs")).body as Job[]).some((j) => j.payload.op === "whoami")).toBe(false);

    pc.state.signedIn = false;
    const out = await ctx.api("/api/integrations/reddit-browser/dms-reddit-pc/test", { method: "POST" });
    expect(out.body).toMatchObject({ ok: false, message: "Not signed in on Studio PC: press Sign in to Reddit for it on the Devices page, and sign in in the window that opens there." });
    pc.state.signedIn = true;
  });

  it("turns an approved reply into a job on that PC, whose result is the proposal's result; pacing still queues", async () => {
    const first = await approve("ER11 is the size you want.");
    expect(first.status).toBe("executed");
    expect(first.result.result).toEqual({ id: "t1_c1", url: "https://www.reddit.com/r/hobbycnc/comments/abc12/x/c1/" });
    const job = pc.state.jobs.at(-1)!;
    expect(job).toMatchObject({ kind: "social.reddit.browser", requires: ["browser"], targetNodeId: "studio-pc", payload: { op: "comment", form: { thing_id: "t3_abc12", text: "ER11 is the size you want." }, username: "dave_dms" } });
    // A post stays in the job list, as a record of what the PC did.
    expect(((await ctx.api("/api/jobs")).body as Job[]).find((j) => j.id === job.id)).toMatchObject({ status: "succeeded" });

    const second = await approve("Second reply.");
    expect(second.result.result).toMatchObject({ status: "scheduled", reason: expect.stringMatching(/is paced/) });
    expect(pc.state.comments).toHaveLength(1);
    await pause(1500);
    await jobs.socialPublish!();
    expect(pc.state.comments.map((c) => c.text)).toEqual(["ER11 is the size you want.", "Second reply."]);
  });

  it("keeps replies queued while the PC is off, pushes Dave once, and sends them when it's back", async () => {
    await ctx.server.workers.disconnect("studio-pc", pc.peer);
    await pause(1500);
    const before = ctx.notifier.sent.length;
    const third = await approve("Third reply.");
    expect(third.status).toBe("executed");
    expect(third.result.result).toMatchObject({ status: "scheduled", reason: expect.stringMatching(/^waiting for the PC: Studio PC, the PC that posts to Reddit, isn't connected \(Devices page\)/) });
    const fourth = await approve("Fourth reply.");
    expect(fourth.result.result).toMatchObject({ status: "scheduled" });
    const waitingPushes = () => ctx.notifier.sent.slice(before).filter((n) => /waiting for your PC/.test(n.title));
    expect(waitingPushes()).toEqual([expect.objectContaining({ title: "Reddit posts are waiting for your PC", body: expect.stringMatching(/^u\/dave_dms: approved posts/) })]);

    // Its turn comes while the PC is still off: it goes back in the queue, nothing fails.
    const waiting = (await outbox()).find((e) => e.id === (third.result.result as { outboxId: string }).outboxId)!;
    await due(waiting.id);
    await jobs.socialPublish!();
    const deferred = (await outbox()).find((e) => e.id === waiting.id)!;
    expect(deferred).toMatchObject({ status: "queued", result: { ok: false, waiting: expect.stringMatching(/isn't connected/) } });
    expect(Date.parse(deferred.notBefore) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(waitingPushes()).toHaveLength(1);
    expect(ctx.notifier.sent.slice(before).some((n) => /failed/i.test(n.title))).toBe(false);
    expect(pc.state.comments).toHaveLength(2);

    // The PC is back.
    await ctx.server.workers.connect(node, pc.peer);
    await due(waiting.id);
    await jobs.socialPublish!();
    expect(pc.state.comments.map((c) => c.text)).toEqual(["ER11 is the size you want.", "Second reply.", "Third reply."]);
    expect((await outbox()).find((e) => e.id === waiting.id)).toMatchObject({ status: "sent", result: { ok: true, id: "t1_c3" } });
    const fourthId = (fourth.result.result as { outboxId: string }).outboxId;
    expect((await ctx.api(`/api/social/outbox/${fourthId}/cancel`, { method: "POST" })).body).toMatchObject({ status: "cancelled" });
  });

  it("counts a PC busy with other work as not there (nothing sent, the reply waits)", async () => {
    await pause(1500);
    const capture = await ctx.server.workers.submit({ kind: "video.capture", requires: ["browser"], payload: {} });
    expect(pc.state.jobs.at(-1)!.id).toBe(capture.id);
    const busy = await approve("Busy reply.");
    expect(busy.result.result).toMatchObject({ status: "scheduled", reason: expect.stringMatching(/didn't take the job \(it may be busy/) });
    const cancelled = ((await ctx.api("/api/jobs")).body as Job[]).filter((j) => j.payload.op === "comment" && j.status === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(pc.state.comments.map((c) => c.text)).not.toContain("Busy reply.");
    await ctx.server.workers.handle("studio-pc", { type: "job.complete", jobId: capture.id, result: null });
    await ctx.api(`/api/social/outbox/${(busy.result.result as { outboxId: string }).outboxId}/cancel`, { method: "POST" });
  });

  it("never runs a post a second time when the PC drops in the middle of it", async () => {
    pc.state.silent = true; // it takes the job, then the connection goes
    const running = ctx.server.workers.run({ kind: "social.reddit.browser", requires: ["browser"], payload: { op: "comment", form: { thing_id: "t3_abc12", text: "x" } }, targetNodeId: "studio-pc" }, { pickupMs: 5_000, timeoutMs: 10_000, once: true });
    await pause(50);
    const job = pc.state.jobs.at(-1)!;
    await ctx.server.workers.disconnect("studio-pc", pc.peer);
    expect(await running).toEqual({ kind: "dropped" });
    pc.state.silent = false;
    await ctx.server.workers.connect(node, pc.peer);
    await pause(50);
    expect(((await ctx.api("/api/jobs")).body as Job[]).find((j) => j.id === job.id)).toMatchObject({ status: "cancelled" });
    expect(pc.state.jobs.filter((j) => j.id === job.id)).toHaveLength(1);
  });

  it("asks Dave to sign in again on the Devices page when the PC's window is signed out", async () => {
    await pause(1500);
    pc.state.signedIn = false;
    const failed = await approve("Signed-out reply.");
    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failed.result)).toMatch(/press Sign in to Reddit on that PC/);
    expect(ctx.notifier.sent.find((n) => n.title === "Reddit sign-in expired")?.body).toMatch(/u\/dave_dms: Reddit isn't signed in as u\/dave_dms/);
    expect((await outbox()).filter((e) => e.status === "queued")).toEqual([]);
    pc.state.signedIn = true;
  });

  it("opens the sign-in window on one PC from the Devices page", async () => {
    const res = await ctx.api("/api/nodes/studio-pc/reddit-login", { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "social.reddit.browser", requires: ["browser"], targetNodeId: "studio-pc", payload: { op: "login", timeoutSec: 300 } });
    await pause(50);
    expect(((await ctx.api("/api/jobs")).body as Job[]).find((j) => j.id === res.body.id)).toMatchObject({ status: "succeeded", result: { ok: true, user: { name: "dave_dms" } } });

    expect((await ctx.api("/api/nodes/nope/reddit-login", { method: "POST" })).status).toBe(404);
    await ctx.server.workers.connect({ id: "laptop", name: "Laptop", capabilities: [] }, { send: () => {} });
    expect((await ctx.api("/api/nodes/laptop/reddit-login", { method: "POST" })).body.error).toMatch(/can't drive a browser/);
    await ctx.server.workers.disconnect("studio-pc", pc.peer);
    expect((await ctx.api("/api/nodes/studio-pc/reddit-login", { method: "POST" })).body.error).toMatch(/offline/);
  });
});
