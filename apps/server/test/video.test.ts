import type { Capability, Job, NewProposal } from "@cc/core";
import { BRANDS, silentWav, type VideoSpecInput } from "@cc/video";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type VideoMediaStore, VideoProductions, videoTtsFromEnv } from "../src/video";
import { DB_URL, makeServer, resetDatabase } from "./helpers";

const spec: VideoSpecInput = {
  id: "openv-trace",
  title: "OpenV: trace a requirement",
  product: "openv",
  type: "short",
  format: "9:16",
  brand: BRANDS.openv,
  scenes: [
    { id: "hook", kind: "title", heading: "Where did this requirement come from?", narration: "Where did this requirement come from?" },
    { id: "map", kind: "capture", steps: [{ action: "goto", url: "https://app.openv.example/projects/demo/map" }], narration: "Open the project map." },
    { id: "cta", kind: "outro", heading: "OpenV", cta: "Try it" },
  ],
  sources: [{ tool: "openv.get_project_map", ref: "demo" }],
};
const targets = [{ accountId: "openv-x", text: "Trace any requirement in two clicks." }];

function fakes(options: { media?: boolean; campaign?: boolean } = {}) {
  const jobs: { kind: string; requires: Capability[]; payload: Record<string, any> }[] = [];
  const proposals: { proposal: NewProposal; options: { forceDraft: string } }[] = [];
  const notes: { title: string; body: string }[] = [];
  const uploads: string[] = [];
  const media: VideoMediaStore = {
    async createUpload(name) {
      uploads.push(name);
      return { putUrl: `https://media.test/put/${name}?sig=1`, publicUrl: `https://media.test/m/${name}` };
    },
    async put(name) {
      uploads.push(name);
      return `https://media.test/m/${name}`;
    },
  };
  const productions = new VideoProductions({
    submit: async (job) => {
      jobs.push(job);
      return { id: `job-${jobs.length}` } as Job;
    },
    propose: async (proposal, opts) => void proposals.push({ proposal, options: opts }),
    notify: async (n) => void notes.push(n),
    hasAction: (t) => t === "social.campaign" && options.campaign !== false,
    media: options.media === false ? undefined : media,
    tts: { elevenlabs: { apiKey: "k", voiceId: "v" } },
    fetch: async () =>
      Response.json({
        audio_base64: Buffer.from(silentWav(1)).toString("base64"),
        alignment: { characters: [..."Hi"], character_start_times_seconds: [0, 0.3], character_end_times_seconds: [0.3, 0.6] },
      }),
  });
  const settle = (i: number, status: "succeeded" | "failed", result: unknown) =>
    productions.onJobSettled({ id: `job-${i + 1}`, kind: jobs[i]!.kind, requires: jobs[i]!.requires, payload: jobs[i]!.payload, status, nodeId: "pc", progress: 1, result, createdAt: "", updatedAt: "" });
  return { productions, jobs, proposals, notes, uploads, settle };
}

describe("video.produce chain", () => {
  it("capture → render → social.campaign draft, through the media store", async () => {
    const f = fakes();
    const started = await f.productions.start({ spec, targets });
    expect(started).toMatchObject({ captureJobId: "job-1", warnings: [expect.stringMatching(/under the 20s target/)] });
    expect(f.jobs[0]).toMatchObject({ kind: "video.capture", requires: ["browser"] });
    expect(f.jobs[0]!.payload.uploads.map.putUrl).toMatch(/^https:\/\/media\.test\/put\/openv-trace-.+\/map\.webm/);

    await f.settle(0, "succeeded", { clips: { map: { file: "map.webm", path: "C:\\w\\map.webm", bytes: 9, trimStartSec: 0.3, durationSec: 4, url: "https://media.test/m/map.webm" } } });
    expect(f.jobs[1]).toMatchObject({ kind: "video.render", requires: ["ffmpeg"], payload: { assets: { map: { url: "https://media.test/m/map.webm", trimStartSec: 0.3, durationSec: 4 } }, encoder: "auto" } });
    expect(f.jobs[1]!.payload.upload.publicUrl).toMatch(/openv-trace\.mp4$/);

    const url = f.jobs[1]!.payload.upload.publicUrl;
    await f.settle(1, "succeeded", { outputPath: "C:\\w\\openv-trace.mp4", bytes: 1e6, durationSec: 21.4, width: 1080, height: 1920, encoder: "h264_nvenc", captionsPath: null, url });
    expect(f.proposals).toHaveLength(1);
    const { proposal, options } = f.proposals[0]!;
    expect(options.forceDraft).toMatch(/reviewed/);
    expect(proposal).toMatchObject({
      vertical: "openv",
      actionType: "social.campaign",
      payload: { title: spec.title, posts: [{ accountId: "openv-x", content: { text: targets[0]!.text, media: [{ url, type: "video" }] } }] },
    });
  });

  it("voices cloud narration on the server and hands the files to the worker", async () => {
    const f = fakes();
    await f.productions.start({ spec: { ...spec, voice: { provider: "elevenlabs" } }, targets });
    const voice = f.jobs[0]!.payload.meta.production.voice;
    expect(Object.keys(voice)).toEqual(["hook", "map"]);
    expect(voice.hook).toMatchObject({ format: "mp3", durationSec: 0.6, words: [{ word: "Hi" }] });
    await f.settle(0, "succeeded", { clips: { map: { file: "m", path: "p", bytes: 1, trimStartSec: 0, durationSec: 3, url: "https://media.test/m/map.webm" } } });
    expect(f.jobs[1]!.payload.voice.hook.url).toMatch(/voice-hook\.mp3$/);
  });

  it("without a media store: one inline capture+render job, then a notification with the path", async () => {
    const f = fakes({ media: false });
    expect(await f.productions.start({ spec, targets })).toMatchObject({ renderJobId: "job-1" });
    expect(f.jobs[0]).toMatchObject({ kind: "video.render", requires: ["ffmpeg", "browser"], payload: { captureInline: true } });
    expect(f.jobs[0]!.payload.upload).toBeUndefined();
    await f.settle(0, "succeeded", { outputPath: "C:\\w\\openv-trace.mp4", bytes: 1, durationSec: 20, width: 1080, height: 1920, encoder: "libx264", captionsPath: null });
    expect(f.proposals).toEqual([]);
    expect(f.notes[0]!.body).toMatch(/C:\\w\\openv-trace\.mp4 on worker pc\. Not proposed for posting because it has no public URL/);
    await expect(f.productions.start({ spec: { ...spec, voice: { provider: "elevenlabs" } } })).rejects.toThrow(/needs a media store/);
  });

  it("reports failures, unknown providers and missing social.campaign", async () => {
    const f = fakes({ campaign: false });
    await f.productions.start({ spec, targets });
    await f.settle(0, "failed", { error: "no browser" });
    expect(f.notes.at(-1)).toEqual({ title: `Video failed: ${spec.title}`, body: "video.capture failed: no browser" });
    await f.settle(0, "succeeded", { clips: { map: { file: "m", path: "p", bytes: 1, trimStartSec: 0, durationSec: 3 } } });
    expect(f.notes.at(-1)!.body).toMatch(/was not uploaded/);

    await f.productions.start({ spec: { ...spec, scenes: spec.scenes.filter((s) => s.kind !== "capture") }, targets });
    const last = f.jobs.length - 1;
    expect(f.jobs[last]).toMatchObject({ kind: "video.render", requires: ["ffmpeg"], payload: { captureInline: false } });
    await f.settle(last, "succeeded", { outputPath: "x", bytes: 1, durationSec: 9, width: 1080, height: 1920, encoder: "libx264", captionsPath: null, url: "https://media.test/m/v.mp4" });
    expect(f.notes.at(-1)!.body).toMatch(/social\.campaign is not available/);

    await expect(f.productions.start({ spec: { ...spec, voice: { provider: "acme" } } })).rejects.toThrow(/not configured on the server/);
    await expect(f.productions.start({ spec: { ...spec, scenes: [] } })).rejects.toThrow();
    // Jobs that aren't part of a production are ignored.
    await f.productions.onJobSettled({ id: "x", kind: "video.render", requires: [], payload: {}, status: "succeeded", nodeId: null, progress: 1, result: null, createdAt: "", updatedAt: "" });
  });

  it("reads TTS keys from the environment only when complete", () => {
    expect(videoTtsFromEnv({})).toEqual({});
    expect(videoTtsFromEnv({ ELEVENLABS_API_KEY: "k" })).toEqual({});
    expect(videoTtsFromEnv({ ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", OPENAI_TTS_API_KEY: "o" })).toMatchObject({ elevenlabs: { voiceId: "v" }, openai: { apiKey: "o" } });
  });
});

describe.skipIf(!DB_URL)("video.produce in the server", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer();
  });
  afterAll(async () => ctx?.server.stop());

  it("is offered to agents, waits for approval, then queues the worker job", async () => {
    expect(ctx.server.actions.executors["video.produce"]?.description).toMatch(/VideoSpec/);
    const proposal = await ctx.server.actions.propose({ vertical: "openv", actionType: "video.produce", summary: "Trace demo", payload: { spec, targets } });
    expect(proposal.status).toBe("pending");
    const done = await ctx.server.actions.approve(proposal.id);
    expect(done).toMatchObject({ status: "executed", result: { ok: true, result: { renderJobId: expect.any(String) } } });

    const jobs = (await ctx.api("/api/jobs")).body as { kind: string; requires: string[]; status: string; payload: any }[];
    const job = (Array.isArray(jobs) ? jobs : (jobs as any).jobs).find((j: any) => j.kind === "video.render");
    expect(job).toMatchObject({ requires: ["ffmpeg", "browser"], status: "queued", payload: { captureInline: true } });
  });

  it("forceDraft holds an action the vertical would run automatically", async () => {
    const held = await ctx.server.actions.propose(
      { vertical: "opend", actionType: "brain.write", summary: "Note", payload: { path: "opend/x.md", body: "x" } },
      { forceDraft: "test reason" },
    );
    expect(held).toMatchObject({ status: "pending", policy: "draft", payload: { policyDowngrade: { from: "auto", reason: "test reason" } } });
  });
});
