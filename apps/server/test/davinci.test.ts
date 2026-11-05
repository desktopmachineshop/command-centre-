import type { BlobInfo } from "@cc/storage";
import type { Capability, Job } from "@cc/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clipName, DavinciRenders, DavinciRequestError } from "../src/davinci";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const VIDEO = "0123456789abcdef0123456789abcdef.mp4";
const PDF = "fedcba9876543210fedcba9876543210.pdf";

function blob(id: string, name: string, contentType: string): BlobInfo {
  return { id, name, contentType, size: 1000, folder: "footage", backend: "local", createdAt: new Date(), vertical: null, work: null, wip: false };
}

function fakes(options: { publicBaseUrl?: string | undefined } = { publicBaseUrl: "https://cc.example/" }) {
  const jobs: { kind: string; requires: Capability[]; payload: Record<string, any> }[] = [];
  const notes: { title: string; body: string; media?: unknown[] }[] = [];
  const files: Record<string, BlobInfo> = { [VIDEO]: blob(VIDEO, "Shop tour/../take 2.mp4", "video/mp4"), [PDF]: blob(PDF, "quote.pdf", "application/pdf") };
  const renders = new DavinciRenders({
    submit: async (job) => {
      jobs.push(job);
      return { id: `job-${jobs.length}` } as Job;
    },
    notify: async (n) => {
      notes.push(n);
    },
    head: async (id) => files[id] ?? null,
    publicBaseUrl: options.publicBaseUrl,
  });
  return { renders, jobs, notes };
}

function settled(status: Job["status"], payload: Record<string, unknown>, result: unknown): Job {
  const now = new Date().toISOString();
  return { id: "j1", kind: "davinci.render", requires: ["davinci"], payload, status, nodeId: "studio-pc", progress: 1, result, createdAt: now, updatedAt: now };
}

describe("clipName", () => {
  it("makes plain, numbered names the worker accepts", () => {
    expect(clipName(0, "take 1.mp4", "mp4")).toBe("01-take 1.mp4");
    expect(clipName(1, "/videos/..%2F/evil:name?.mov", "mov")).toBe("02-evil-name-.mov");
    expect(clipName(2, "../../etc/passwd", "mp4")).toBe("03-passwd.mp4");
    expect(clipName(9, "", "webm")).toBe("10-clip.webm");
    expect(clipName(0, "...hidden..mp4", "mp4")).toBe("01-hidden.mp4");
  });
});

describe("davinci.render requests", () => {
  it("turns storage files and URLs into one queued job, in order", async () => {
    const { renders, jobs } = fakes();
    const out = await renders.start({
      clips: [{ fileId: VIDEO }, { url: "https://cdn.example/b-roll/drone%20shot.mov" }, { url: "https://cdn.example/x", name: "outro.mp4" }],
      outputName: "shop tour",
      fps: "25",
      title: "Shop tour",
    });
    expect(out).toEqual({ jobId: "job-1", clips: 3, preset: "YouTube - 1080p" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "davinci.render",
      requires: ["davinci"],
      payload: {
        clips: [
          { url: `https://cc.example/media/${VIDEO}`, name: "01-take 2.mp4" },
          { url: "https://cdn.example/b-roll/drone%20shot.mov", name: "02-drone shot.mov" },
          { url: "https://cdn.example/x", name: "03-outro.mp4" },
        ],
        preset: "YouTube - 1080p",
        outputName: "shop tour",
        fps: "25",
        upload: true,
        uploadFolder: "renders",
        meta: { davinci: { title: "Shop tour" } },
      },
    });
  });

  it("refuses what the PC couldn't render, before anything is queued", async () => {
    const { renders, jobs } = fakes();
    await expect(renders.start({ clips: [] })).rejects.toThrow(DavinciRequestError);
    await expect(renders.start({ clips: [{ url: "file:///etc/passwd" }] })).rejects.toThrow(/Invalid davinci.render request/);
    await expect(renders.start({ clips: [{ fileId: "0".repeat(32) + ".mp4" }] })).rejects.toThrow(/no storage file/);
    await expect(renders.start({ clips: [{ fileId: PDF }] })).rejects.toThrow(/application\/pdf, not an mp4/);
    await expect(renders.start({ clips: [{ url: "https://x/a.mp4" }], outputName: "../out" })).rejects.toThrow(/Invalid/);
    await expect(fakes({ publicBaseUrl: undefined }).renders.start({ clips: [{ fileId: VIDEO }] })).rejects.toThrow(/PUBLIC_BASE_URL/);
    expect(jobs).toEqual([]);
  });

  it("is an action agents can propose, checked when it is proposed", async () => {
    const { renders, jobs } = fakes();
    const action = renders.executors()["davinci.render"]!;
    expect(action.description).toMatch(/DaVinci Resolve/);
    await expect(action.validate!({ clips: [{ fileId: PDF }] }, { vertical: "dms" })).rejects.toThrow(/not an mp4/);
    await action.validate!({ clips: [{ fileId: VIDEO }] }, { vertical: "dms" });
    expect(jobs).toEqual([]); // validating queues nothing
    await action.execute({ clips: [{ fileId: VIDEO }] }, {} as never);
    expect(jobs).toHaveLength(1);
  });
});

describe("davinci.render results", () => {
  const payload = { outputName: "shop tour", meta: { davinci: { title: "Shop tour" } } };

  it("sends Dave the render when it is uploaded", async () => {
    const { renders, notes } = fakes();
    const url = "https://cc.example/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4";
    await renders.onJobSettled(settled("succeeded", payload, { outputPath: "C:\\work\\out\\shop tour.mp4", bytes: 52_428_800, url }));
    expect(notes).toEqual([{ title: "Resolve render ready: Shop tour", body: `50 MB: ${url}`, media: [{ url, type: "video", alt: "Shop tour" }] }]);
  });

  it("says where the file is when it wasn't uploaded, and reports failures", async () => {
    const { renders, notes } = fakes();
    await renders.onJobSettled(settled("succeeded", { outputName: "cut" }, { outputPath: "/work/out/cut.mov", bytes: 1000 }));
    await renders.onJobSettled(settled("failed", payload, { error: "DaVinci Resolve: Resolve isn't running" }));
    await renders.onJobSettled(settled("cancelled", payload, null));
    await renders.onJobSettled({ ...settled("succeeded", payload, {}), kind: "video.render" });
    expect(notes).toEqual([
      { title: "Resolve render ready: cut", body: "1 MB: /work/out/cut.mov on worker studio-pc", media: [] },
      { title: "Resolve render failed: Shop tour", body: "DaVinci Resolve: Resolve isn't running" },
    ]);
  });
});

describe.skipIf(!DB_URL)("davinci.render in the server", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { PUBLIC_BASE_URL: "https://cc.example" } });
  });
  afterAll(async () => ctx?.server.stop());

  it("queues a job from POST /api/davinci/render, and answers 400 for bad requests", async () => {
    const res = await ctx.api("/api/davinci/render", { method: "POST", json: { clips: [{ url: "https://cdn.example/a.mp4" }], preset: "H.264 Master" } });
    expect(res).toMatchObject({ status: 201, body: { jobId: expect.any(String), clips: 1, preset: "H.264 Master" } });
    const jobs = (await ctx.api("/api/jobs")).body as { id: string; kind: string; requires: string[]; status: string }[];
    expect(jobs.find((j) => j.id === res.body.jobId)).toMatchObject({ kind: "davinci.render", requires: ["davinci"], status: "queued" });

    expect((await ctx.api("/api/davinci/render", { method: "POST", json: { clips: [{ fileId: VIDEO }] } }))).toMatchObject({ status: 400, body: { error: expect.stringMatching(/no storage file/) } });
    expect((await ctx.api("/api/davinci/render", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await ctx.api("/api/davinci/render", { method: "POST", json: {}, headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("is offered to agents and waits for Dave's approval", async () => {
    expect(ctx.server.actions.executors["davinci.render"]?.description).toMatch(/DaVinci Resolve/);
    const proposal = await ctx.server.actions.propose({ vertical: "dms", actionType: "davinci.render", summary: "Render the shop tour", payload: { clips: [{ url: "https://cdn.example/a.mp4" }] } });
    expect(proposal.status).toBe("pending");
    const done = await ctx.server.actions.approve(proposal.id);
    expect(done).toMatchObject({ status: "executed", result: { ok: true, result: { jobId: expect.any(String) } } });
  });
});
