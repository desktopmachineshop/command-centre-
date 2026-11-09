import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Capability, Job, NewProposal } from "@cc/core";
import { BRANDS, silentWav, VideoSpec, type VideoSpecInput } from "@cc/video";
import { ELEVENLABS_DEFAULT_VOICE } from "@cc/voice";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { type VideoMediaStore, VideoProductions, videoTtsFromConfig } from "../src/video";
import { createVideoMcpServer } from "../src/video-mcp";
import { MemoryVideoProjectStore, PgVideoProjectStore } from "../src/video-projects";
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

/** A stand-in for the server's own voices: 16 kHz samples, one second per call, with a download step. */
function fakeLocal() {
  const calls: { text: string; voice?: string; fallback?: boolean }[] = [];
  const installs: string[] = [];
  return {
    calls,
    installs,
    voice: "piper:cori",
    ttsModel: { dir: "piper" } as never,
    async installVoice(id: string) {
      installs.push(id);
    },
    async synthesize(text: string, opts: { voice?: string; speed?: number; fallback?: boolean } = {}) {
      calls.push({ text, voice: opts.voice, fallback: opts.fallback });
      return { samples: new Float32Array(16000), sampleRate: 16000, voice: opts.voice ?? "piper:cori" };
    },
  };
}

function fakes(options: { media?: boolean; campaign?: boolean; local?: ReturnType<typeof fakeLocal> | null } = {}) {
  const jobs: { kind: string; requires: Capability[]; payload: Record<string, any> }[] = [];
  const proposals: { proposal: NewProposal; options: { forceDraft: string } }[] = [];
  const notes: { title: string; body: string; media?: unknown[] }[] = [];
  const uploads: string[] = [];
  const stored = new Map<string, string>();
  const removed: string[] = [];
  const spoken: string[] = [];
  const media: VideoMediaStore = {
    async createUpload(name) {
      uploads.push(name);
      return { putUrl: `https://media.test/put/${name}?sig=1`, publicUrl: `https://media.test/m/${name}` };
    },
    async put(name, bytes) {
      uploads.push(name);
      stored.set(name, new TextDecoder().decode(bytes.slice(0, 200_000)));
      return `https://media.test/m/${name}`;
    },
    async remove(url) {
      removed.push(url);
      return true;
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
    local: options.local ?? null,
    fetch: async (_url, init) => {
      spoken.push(JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}")).text);
      return Response.json({
        audio_base64: Buffer.from(silentWav(1)).toString("base64"),
        alignment: { characters: [..."Hi"], character_start_times_seconds: [0, 0.3], character_end_times_seconds: [0.3, 0.6] },
      });
    },
  });
  const settle = (i: number, status: "succeeded" | "failed", result: unknown) =>
    productions.onJobSettled({ id: `job-${i + 1}`, kind: jobs[i]!.kind, requires: jobs[i]!.requires, payload: jobs[i]!.payload, status, nodeId: "pc", progress: 1, result, createdAt: "", updatedAt: "" });
  return { productions, jobs, proposals, notes, uploads, stored, removed, spoken, settle };
}

describe("video.produce chain", () => {
  it("capture → render → social.campaign draft, through the media store", async () => {
    const f = fakes();
    const started = await f.productions.start({ spec, targets });
    expect(started).toMatchObject({ captureJobId: "job-1", projectId: expect.any(String), revision: 1, warnings: expect.arrayContaining([expect.stringMatching(/under the 20s target/)]) });
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
    // Nothing to play without a public URL.
    expect(f.notes[0]!.media).toEqual([]);
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
    // The notification carries the video, so the briefing view plays it.
    expect(f.notes.at(-1)!.media).toEqual([
      { url: "https://media.test/m/v.mp4", type: "video", alt: spec.title, durationSec: 9, width: 1080, height: 1920 },
    ]);

    await expect(f.productions.start({ spec: { ...spec, voice: { provider: "acme" } } })).rejects.toThrow(/not configured on the server/);
    await expect(f.productions.start({ spec: { ...spec, scenes: [] } })).rejects.toThrow();
    // Jobs that aren't part of a production are ignored.
    await f.productions.onJobSettled({ id: "x", kind: "video.render", requires: [], payload: {}, status: "succeeded", nodeId: null, progress: 1, result: null, createdAt: "", updatedAt: "" });
  });

  it("voices with the server's own voices (the ones chat uses), in exactly the voice asked for", async () => {
    const local = fakeLocal();
    const f = fakes({ local });
    const narrated = { ...spec, voice: { provider: "local", voiceId: "kokoro:bm_george" } };
    expect(() => f.productions.executors()["video.produce"]!.validate!({ spec: narrated }, { vertical: "openv" })).not.toThrow();
    await f.productions.start({ spec: narrated, targets });
    expect(local.installs).toEqual(["kokoro:bm_george"]);
    expect(local.calls.length).toBeGreaterThan(0);
    expect(local.calls.every((c) => c.voice === "kokoro:bm_george" && c.fallback === false)).toBe(true);
    const voice = f.jobs[0]!.payload.meta.production.voice;
    expect(Object.values(voice)[0]).toMatchObject({ format: "wav", durationSec: 1 });
    expect(f.uploads.some((u) => /voice-.*\.wav$/.test(u))).toBe(true);
  });

  it("refuses a voice it can't use when proposed, listing the ones it can", () => {
    const f = fakes({ local: fakeLocal() });
    const validate = (voice: Record<string, unknown>) => () => f.productions.executors()["video.produce"]!.validate!({ spec: { ...spec, voice } }, { vertical: "dms" });
    expect(validate({ provider: "openai" })).toThrow(/"openai" is not configured.*"local" with voiceId one of piper:cori \(Cori, British female\)/);
    expect(validate({ provider: "local", voiceId: "nobody" })).toThrow(/no server voice "nobody"/);
    expect(validate({ provider: "silent" })).not.toThrow();
    const off = fakes({ local: null });
    expect(() => off.productions.executors()["video.produce"]!.validate!({ spec: { ...spec, voice: { provider: "local" } } }, { vertical: "dms" })).toThrow(/turned off/);
  });

  it("refuses a malformed spec when proposed, with a readable error", async () => {
    const { productions, jobs } = fakes();
    const executor = productions.executors()["video.produce"]!;
    const bad = { spec: { title: "Demo", product: "OpenD", type: "promo", format: "vertical", scenes: [{ type: "intro" }] } };
    let message = "";
    try {
      await executor.validate!(bad, { vertical: "opend" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("video-reel skill");
    expect(message).toContain("spec.product");
    expect(message).not.toContain('"code"');
    expect(() => executor.validate!({ spec }, { vertical: "openv" })).not.toThrow();
    expect(jobs).toHaveLength(0);
  });

  it("takes TTS keys from the documented voice settings", () => {
    const tts = (env: Record<string, string>) => videoTtsFromConfig(loadConfig({ ...env, DATABASE_URL: "postgres://x", ADMIN_TOKEN: "admin-token-for-tests-0123456789" }).voice.providers);
    expect(tts({})).toEqual({});
    // The old undocumented names are ignored.
    expect(tts({ ELEVENLABS_VOICE_ID: "v", OPENAI_TTS_API_KEY: "o" })).toEqual({});
    expect(tts({ ELEVENLABS_API_KEY: "k" })).toEqual({ elevenlabs: { apiKey: "k", voiceId: ELEVENLABS_DEFAULT_VOICE } });
    expect(
      tts({ ELEVENLABS_API_KEY: "k", VOICE_ELEVENLABS_VOICE: "v", VOICE_ELEVENLABS_TTS_MODEL: "m", OPENAI_API_KEY: "o", VOICE_OPENAI_VOICE: "fable", VOICE_OPENAI_TTS_MODEL: "tts" }),
    ).toEqual({ elevenlabs: { apiKey: "k", voiceId: "v", modelId: "m" }, openai: { apiKey: "o", model: "tts", voice: "fable" } });
  });
});

describe("video projects: edit without regenerating", () => {
  const clip = (id: string, n = 1) => ({ file: `${id}.webm`, path: `C:\\w\\${id}.webm`, bytes: 9, trimStartSec: 0.3, durationSec: 4, url: `https://media.test/m/r${n}-${id}.webm` });
  const rendered = (n: number, extra: Record<string, unknown> = {}) => ({ outputPath: "C:\\w\\openv-trace.mp4", bytes: 1e6, durationSec: 21.4, width: 1080, height: 1920, encoder: "h264_nvenc", captionsPath: null, url: `https://media.test/m/r${n}.mp4`, ...extra });
  const voiced = { ...spec, voice: { provider: "elevenlabs" } };

  /** A project produced once: narration for hook and map on the server, map recorded, r1 rendered. */
  async function produced(options: Parameters<typeof fakes>[0] = {}) {
    const f = fakes(options);
    const started = (await f.productions.start({ spec: voiced, targets })) as { projectId: string };
    await f.settle(0, "succeeded", { clips: { map: clip("map") } });
    await f.settle(1, "succeeded", rendered(1, { captionsUrl: "https://media.test/m/r1.srt", timeline: { total: 21.4, scenes: [{ id: "hook", start: 0, duration: 2.5, voiceStart: 0.3 }, { id: "map", start: 2.5, duration: 4, voiceStart: 2.8 }, { id: "cta", start: 6.5, duration: 4, voiceStart: null }] } }));
    return { f, id: started.projectId };
  }

  it("keeps every production as a project: spec, asset manifest, render and history", async () => {
    const { f, id } = await produced();
    const project = (await f.productions.projects.get(id))!;
    expect(project).toMatchObject({ vertical: "openv", specId: "openv-trace", title: spec.title, status: "active", current: 1 });
    const [r1] = await f.productions.projects.revisions(id);
    expect(r1).toMatchObject({ revision: 1, basedOn: null, status: "ready", changes: ["created"], outputs: { video: { url: "https://media.test/m/r1.mp4", durationSec: 21.4 }, captionsUrl: "https://media.test/m/r1.srt" } });
    // "auto" was resolved to the natural voice the server has a key for, and that is what the spec records.
    expect((await f.productions.start({ spec, targets })) as any).toMatchObject({ revision: 1 });
    expect(r1!.spec.voice.provider).toBe("elevenlabs");
    // The pool maps each scene's asset key to its file.
    const keys = r1!.assets;
    expect(project.pool[keys.hook!.voice!]).toMatchObject({ kind: "voice", sceneId: "hook", format: "mp3", durationSec: 0.6, url: expect.stringMatching(/r1\/voice-hook\.mp3$/) });
    expect(project.pool[keys.map!.capture!]).toMatchObject({ kind: "capture", sceneId: "map", url: "https://media.test/m/r1-map.webm", trimStartSec: 0.3, durationSec: 4 });
    expect(Object.keys(project.pool)).toHaveLength(3);
    // The campaign names the project, so "that reel we posted" can be found again.
    expect(f.proposals[0]!.proposal.payload).toMatchObject({ video: { projectId: id, revision: 1 } });
  });

  it("a narration edit voices only that scene and records nothing", async () => {
    const { f, id } = await produced();
    const said = f.spoken.length;
    const revise = f.productions.executors()["video.revise"]!;
    const payload = { projectId: id, patch: { scenes: [{ op: "update", id: "hook", set: { narration: "Who asked for this requirement?" } }] }, revisionPreview: "agent says ok" };
    await revise.validate!(payload, { vertical: "openv" });
    const prepared = await revise.prepare!(payload);
    expect(prepared.note).toBe("[r1 → r2: hook: narration. Re-renders with new voice for hook; re-uses 1 of 2 narrations and 1 of 1 recording.]");
    expect(prepared.payload.revisionPreview).toMatchObject({ from: 1, to: 2, changes: ["hook: narration"], voice: { make: ["hook"], reuse: ["map"] }, capture: { make: [], reuse: ["map"] }, renders: true });
    expect(f.spoken).toHaveLength(said); // planning made nothing

    const result = (await revise.execute(prepared.payload, {} as never)) as any;
    expect(result).toMatchObject({ projectId: id, revision: 2, renderJobId: "job-3" });
    expect(f.spoken.slice(said)).toEqual(["Who asked for this requirement?"]);
    // Straight to render: no capture job, the old recording and the other narration re-used.
    const job = f.jobs[2]!;
    expect(job).toMatchObject({ kind: "video.render", requires: ["ffmpeg"], payload: { captureInline: false, assets: { map: { url: "https://media.test/m/r1-map.webm", trimStartSec: 0.3, durationSec: 4 } } } });
    expect(job.payload.voice.map.url).toMatch(/r1\/voice-map\.mp3$/);
    expect(job.payload.voice.hook.url).toMatch(/r2\/voice-hook\.mp3$/);
    expect(job.payload.spec.scenes[0].narration).toBe("Who asked for this requirement?");

    await f.settle(2, "succeeded", rendered(2));
    expect(f.notes.at(-1)).toMatchObject({ title: `Video ready: ${spec.title}`, body: expect.stringMatching(/r2\.mp4 \(revision 2: Re-renders with new voice for hook/) });
    expect(await f.productions.projects.revision(id, 2)).toMatchObject({ status: "ready", basedOn: 1, outputs: { video: { url: "https://media.test/m/r2.mp4" } } });
    expect(await f.productions.projects.revision(id, 1)).toMatchObject({ status: "ready", outputs: { video: { url: "https://media.test/m/r1.mp4" } } });
  });

  it("a changed capture scene is the only one recorded; text, captions and order only re-compose", async () => {
    const { f, id } = await produced();
    const said = f.spoken.length;
    const two = (await f.productions.revise({ projectId: id, patch: { scenes: [{ op: "add", scene: { id: "detail", kind: "capture", steps: [{ action: "goto", url: "https://app.openv.example/projects/demo/req/7" }] }, after: "map" }] } })) as any;
    expect(two).toMatchObject({ revision: 2, captureJobId: "job-3" });
    expect(f.jobs[2]).toMatchObject({ kind: "video.capture", payload: { scenes: ["detail"] } });
    expect(Object.keys(f.jobs[2]!.payload.uploads)).toEqual(["detail"]);
    await f.settle(2, "succeeded", { clips: { detail: clip("detail", 2) } });
    expect(f.jobs[3]!.payload.assets).toEqual({ map: { url: "https://media.test/m/r1-map.webm", trimStartSec: 0.3, durationSec: 4 }, detail: { url: "https://media.test/m/r2-detail.webm", trimStartSec: 0.3, durationSec: 4 } });
    await f.settle(3, "succeeded", rendered(2));

    const three = (await f.productions.revise({
      projectId: id,
      patch: { set: { captions: { style: "plain" }, format: "16:9" }, scenes: [{ op: "update", id: "hook", set: { heading: "Trace it" } }, { op: "move", id: "detail", before: "map" }, { op: "update", id: "map", set: { clip: { startSec: 1, endSec: 3 } } }] },
      keepCaptures: true,
    })) as any;
    expect(three).toMatchObject({ revision: 3, renderJobId: "job-5", plan: "Re-renders only, re-using 2 of 2 narrations and 2 of 2 recordings: no new voice or recording." });
    expect(f.jobs[4]!.payload.spec).toMatchObject({ format: "16:9", scenes: [{ id: "hook", heading: "Trace it" }, { id: "detail", viewport: { width: 540, height: 960 } }, { id: "map", clip: { startSec: 1, endSec: 3 } }, { id: "cta" }] });
    expect(f.spoken).toHaveLength(said);
    expect(f.jobs.filter((j) => j.kind === "video.capture")).toHaveLength(2);
    // Without keepCaptures a new format means new recordings: the page is laid out for the new shape.
    const plan = await f.productions.executors()["video.revise"]!.prepare!({ projectId: id, fromRevision: 2, patch: { set: { format: "16:9" } } });
    expect(plan.note).toMatch(/re-records map, detail/);
  });

  it("renders nothing when only the title changes, re-renders on request, and rolls back for free", async () => {
    const { f, id } = await produced();
    const titled = (await f.productions.revise({ projectId: id, patch: { set: { title: "OpenV: trace anything" } } })) as any;
    expect(titled).toMatchObject({ revision: 2, rendered: false, video: "https://media.test/m/r1.mp4" });
    expect(f.jobs).toHaveLength(2);
    expect((await f.productions.projects.get(id))!.title).toBe("OpenV: trace anything");

    const again = (await f.productions.rerender({ projectId: id, encoder: "cpu", preset: "slow" })) as any;
    expect(again).toMatchObject({ revision: 3, renderJobId: "job-3" });
    expect(f.jobs[2]!.payload).toMatchObject({ encoder: "cpu", preset: "slow" });
    await f.settle(2, "failed", { error: "disk full" });
    expect(await f.productions.projects.revision(id, 3)).toMatchObject({ status: "failed", error: "video.render: disk full" });

    await f.productions.revise({ projectId: id, patch: { scenes: [{ op: "update", id: "hook", set: { narration: "A new hook." } }] } });
    const said = f.spoken.length;
    const back = (await f.productions.revise({ projectId: id, fromRevision: 1 })) as any;
    expect(back).toMatchObject({ revision: 5, plan: "Re-renders only, re-using 2 of 2 narrations and 1 of 1 recording: no new voice or recording." });
    expect(f.spoken).toHaveLength(said);
    expect((await f.productions.projects.revision(id, 5))!.changes[0]).toBe("back to r1");
    expect(f.jobs.at(-1)!.payload.spec.scenes[0].narration).toBe(spec.scenes[0]!.narration);
  });

  it("refuses edits it can't make, with errors an agent can act on", async () => {
    const { f, id } = await produced();
    const validate = (payload: Record<string, unknown>) => f.productions.executors()["video.revise"]!.validate!(payload, { vertical: "openv" });
    await expect(validate({ projectId: id, patch: { scenes: [{ op: "update", id: "nope", set: {} }] } })).rejects.toThrow(/no scene "nope" \(scenes: hook, map, cta\)/);
    await expect(validate({ projectId: id, patch: { set: { format: "4:3" } } })).rejects.toThrow(/does not leave a valid VideoSpec/);
    await expect(validate({ projectId: id, patch: { set: { voice: { provider: "acme" } } } })).rejects.toThrow(/not configured on the server/);
    await expect(validate({ projectId: id, fromRevision: 9 })).rejects.toThrow(/has no revision 9 \(it has 1 to 1\)/);
    await expect(validate({ projectId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/no video project/);
    await expect(validate({ projectId: "x", patch: {} })).rejects.toThrow(/video\.revise payload is not valid/);
    expect(f.jobs).toHaveLength(2);
  });

  it("keeps narration the worker made itself, so the next revision doesn't make it again", async () => {
    const f = fakes();
    const { projectId: id } = (await f.productions.start({ spec: { ...spec, voice: { provider: "flite" } } })) as any;
    await f.settle(0, "succeeded", { clips: { map: clip("map") } });
    const render = f.jobs[1]!.payload;
    expect(Object.keys(render.voiceUploads)).toEqual(["hook", "map"]);
    expect(render.voice).toEqual({});
    const voice = (sid: string) => ({ url: `https://media.test/m/flite-${sid}.wav`, format: "wav", durationSec: 1.2, words: [{ word: "Hi", start: 0, end: 0.4 }] });
    await f.settle(1, "succeeded", rendered(1, { voice: { hook: voice("hook"), map: voice("map") } }));
    await f.productions.revise({ projectId: id, patch: { scenes: [{ op: "update", id: "cta", set: { cta: "Start free" } }] } });
    expect(f.jobs[2]!.payload.voice).toEqual({ hook: voice("hook"), map: voice("map") });
    expect(f.jobs[2]!.payload.voiceUploads).toBeUndefined();
  });

  it("exports an editable timeline: per-scene clips, narration and music as FCPXML, optionally opened in Resolve", async () => {
    const { f, id } = await produced();
    await f.productions.revise({ projectId: id, patch: { set: { music: { url: "https://cdn.example/track.mp3", volumeDb: -22 } } } });
    await f.settle(2, "succeeded", rendered(2, { captionsUrl: "https://media.test/m/r2.srt" }));

    const started = (await f.productions.executors()["video.export"]!.execute({ projectId: id, format: "resolve-draft" }, {} as never)) as any;
    expect(started).toMatchObject({ revision: 2, format: "resolve-draft", renderJobId: "job-4" });
    const job = f.jobs[3]!;
    expect(job).toMatchObject({ kind: "video.render", requires: ["ffmpeg"], payload: { stemsOnly: true, meta: { production: { stage: "export", exportFormat: "resolve-draft" } } } });
    expect(Object.keys(job.payload.stemUploads)).toEqual(["hook", "map", "cta"]);
    expect(job.payload.upload).toBeUndefined();

    const stems = Object.fromEntries(["hook", "map", "cta"].map((s) => [s, { url: `https://media.test/m/stem-${s}.mp4`, durationSec: 4 }]));
    const timeline = { total: 10.5, scenes: [{ id: "hook", start: 0, duration: 2.5, voiceStart: 0.3 }, { id: "map", start: 2.5, duration: 4, voiceStart: 2.8 }, { id: "cta", start: 6.5, duration: 4, voiceStart: null }] };
    await f.settle(3, "succeeded", { outputPath: "C:\\w", bytes: 0, durationSec: 10.5, width: 1080, height: 1920, encoder: "libx264", captionsPath: null, stems, timeline });

    const name = [...f.stored.keys()].find((k) => k.endsWith(".fcpxml"))!;
    expect(name).toMatch(/r2\/edit\/openv-trace-r2\.fcpxml$/);
    const doc = f.stored.get(name)!;
    expect(doc).toContain('<fcpxml version="1.9">');
    expect(doc).toContain('src="media/01-hook.mp4"');
    expect(doc).toContain('<asset-clip ref="r3" lane="-1" name="voice hook" offset="9/30s" start="0s" duration="28800/48000s" audioRole="dialogue"/>');
    expect(doc).toContain('lane="-2" name="music" offset="0s" start="0s" duration="315/30s" audioRole="music">');
    expect(doc).toContain('<adjust-volume amount="-22dB"/>');

    const entry = (await f.productions.projects.revision(id, 2))!.outputs.exports![0]!;
    expect(entry).toMatchObject({ format: "resolve-draft", url: expect.stringMatching(/\.fcpxml$/), captionsUrl: "https://media.test/m/r2.srt", davinciJobId: "job-5" });
    expect(entry.files.map((x) => x.name)).toEqual(["01-hook.mp4", "voice-hook.mp3", "02-map.mp4", "voice-map.mp3", "03-cta.mp4", "music.mp3"]);
    // Resolve gets the clips, the timeline document and the captions, as a draft for Dave to edit.
    expect(f.jobs[4]).toMatchObject({
      kind: "davinci.render",
      requires: ["davinci"],
      payload: { mode: "draft", project: "OpenV trace a requirement", fps: "30", clips: entry.files, timelineFile: { url: entry.url, name: "openv-trace-r2.fcpxml" }, extras: [{ url: "https://media.test/m/r2.srt", name: "captions.srt" }], meta: { davinci: { clips: 6 } } },
    });
    expect(f.notes.at(-1)).toMatchObject({ title: "Editable timeline ready: OpenV: trace a requirement r2", body: expect.stringMatching(/3 scene clips, 2 narration clips, music, captions\.srt\. DaVinci Resolve is opening it/) });

    // Plain FCPXML: no Resolve job, and the notification says where the media goes.
    await f.productions.export({ projectId: id, format: "fcpxml" });
    await f.settle(5, "succeeded", { outputPath: "C:\\w", bytes: 0, durationSec: 10.5, width: 1080, height: 1920, encoder: "libx264", captionsPath: null, stems, timeline });
    expect(f.jobs).toHaveLength(6);
    expect(f.notes.at(-1)!.body).toMatch(/Timeline \(FCPXML 1\.9\): https:.*download the 6 files/);
    // A worker that sends no clips back fails the export, not the revision.
    await f.productions.export({ projectId: id, format: "fcpxml" });
    await f.settle(6, "succeeded", { outputPath: "C:\\w", bytes: 0, durationSec: 10.5, width: 1080, height: 1920, encoder: "libx264", captionsPath: null });
    expect(f.notes.at(-1)!.title).toMatch(/Video export failed/);
    expect((await f.productions.projects.revision(id, 2))!.status).toBe("ready");
  });

  it("keeps an active project's files, and archives it on request or after the retention period", async () => {
    const { f, id } = await produced();
    const kept = await f.productions.keptFiles();
    expect(kept).toEqual(expect.arrayContaining(["https://media.test/m/r1-map.webm", "https://media.test/m/r1.mp4", "https://media.test/m/r1.srt"]));
    expect(kept.filter((u) => /voice-/.test(u))).toHaveLength(2);
    expect(await f.productions.archiveStale(90)).toEqual([]);
    expect(await f.productions.archiveStale(0)).toEqual([]);

    const archived = await f.productions.archive(id);
    expect(archived).toMatchObject({ projectId: id, deleted: 3 });
    expect(f.removed).toEqual(expect.arrayContaining(["https://media.test/m/r1-map.webm"]));
    expect(f.removed).not.toContain("https://media.test/m/r1.mp4"); // the render stays until its own retention
    expect(await f.productions.projects.get(id)).toMatchObject({ status: "archived", pool: {} });
    expect(await f.productions.keptFiles()).toEqual([]);
    await expect(f.productions.revise({ projectId: id, patch: { set: { title: "x" } } })).rejects.toThrow(/is archived/);
    expect(await f.productions.archive(id)).toMatchObject({ deleted: 0 });

    // Nothing touched for longer than the retention period: archived by the nightly job.
    let now = new Date("2026-11-01T00:00:00Z");
    const old = new VideoProductions({ submit: async () => ({ id: "j" }) as Job, propose: async () => {}, notify: async () => {}, hasAction: () => false, projects: new MemoryVideoProjectStore(() => now), now: () => now });
    await old.start({ spec: { ...spec, voice: { provider: "silent" } } });
    now = new Date("2026-11-20T00:00:00Z");
    expect(await old.archiveStale(30)).toEqual([]);
    expect(await old.archiveStale(14)).toEqual([spec.title]);
  });

  it("lets agents find a project and read its spec, scenes and history (read-only)", async () => {
    const { f, id } = await produced();
    await f.productions.revise({ projectId: id, patch: { scenes: [{ op: "update", id: "cta", set: { cta: "Start free" } }] } });
    const call = async (server: McpServer, name: string, args: Record<string, unknown>) => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "test", version: "0" });
      await client.connect(clientT);
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return res.isError ? res.content[0]!.text : JSON.parse(res.content[0]!.text);
    };
    const all = createVideoMcpServer(f.productions.projects);
    const list = await call(all, "list_video_projects", { query: "trace requirement" });
    expect(list).toEqual([expect.objectContaining({ id, title: spec.title, vertical: "openv", revisions: 2, format: "9:16", latest: expect.objectContaining({ revision: 2, status: "producing", changes: ["cta: cta"] }) })]);
    expect(await call(createVideoMcpServer(f.productions.projects), "list_video_projects", { query: "nothing like it" })).toEqual([]);

    const project = await call(createVideoMcpServer(f.productions.projects), "get_video_project", { projectId: id, revision: 1 });
    expect(project).toMatchObject({ id, revision: 1, latest_revision: 2, spec: { id: "openv-trace", voice: { provider: "elevenlabs" } }, outputs: { video: { url: "https://media.test/m/r1.mp4" }, captions: "https://media.test/m/r1.srt" } });
    expect(project.scenes).toEqual([
      { id: "hook", kind: "title", heading: spec.scenes[0]!.kind === "title" ? spec.scenes[0]!.heading : "", narration: "Where did this requirement come from?", start: 0, seconds: 2.5, voice: "stored" },
      { id: "map", kind: "capture", narration: "Open the project map.", start: 2.5, seconds: 4, voice: "stored", recording: "stored" },
      { id: "cta", kind: "outro", heading: "OpenV", start: 6.5, seconds: 4 },
    ]);
    expect(project.history.map((h: any) => [h.revision, h.based_on, h.status])).toEqual([[1, null, "ready"], [2, 1, "producing"]]);
    expect(project.warnings.join(" ")).toMatch(/no brand logo/);
    // A business's run sees only its own projects.
    expect(await call(createVideoMcpServer(f.productions.projects, "dms"), "list_video_projects", {})).toEqual([]);
    expect(await call(createVideoMcpServer(f.productions.projects, "dms"), "get_video_project", { projectId: id })).toMatch(/no video project/);
  });
});

describe.skipIf(!DB_URL)("video projects in Postgres", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer();
  });
  afterAll(async () => ctx?.server.stop());

  it("stores projects, their pool and revisions, and offers the actions and tools", async () => {
    const store = ctx.server.video.projects;
    expect(store).toBeInstanceOf(PgVideoProjectStore);
    const id = "3b0c7a52-5b7e-4d0e-9a53-0d6a4e1f2c11";
    const parsed = VideoSpec.parse(spec);
    expect(await store.create({ id, vertical: "openv", specId: parsed.id, title: parsed.title })).toMatchObject({ id, status: "active", current: 0, pool: {} });
    const asset = { kind: "voice" as const, url: "https://x.test/media/a.mp3", sceneId: "hook", revision: 1, createdAt: new Date().toISOString(), format: "mp3" as const, durationSec: 1 };
    await store.addAssets(id, { k1: asset });
    await store.addAssets(id, { k1: { ...asset, url: "https://x.test/media/other.mp3" }, k2: { ...asset, sceneId: "map" } });
    await store.addRevision(id, { revision: 1, basedOn: null, spec: parsed, assets: { hook: { voice: "k1" } }, composeKey: "c1", changes: ["created"], plan: "p", status: "producing", outputs: {}, request: { targets: [], encoder: "auto" } });
    await store.updateRevision(id, 1, { status: "ready", outputs: { video: { url: "https://x.test/media/v.mp4", durationSec: 9, width: 1080, height: 1920, bytes: 1, encoder: "libx264" } } });
    const project = (await store.get(id))!;
    expect(project).toMatchObject({ current: 1, pool: { k1: { url: "https://x.test/media/a.mp3" }, k2: { sceneId: "map" } } });
    expect(await store.revision(id, 1)).toMatchObject({ status: "ready", spec: { id: "openv-trace" }, assets: { hook: { voice: "k1" } }, outputs: { video: { durationSec: 9 } }, request: { encoder: "auto" } });
    expect((await store.list({ vertical: "openv" })).map((p) => p.id)).toEqual([id]);
    expect(await store.list({ vertical: "dms" })).toEqual([]);
    expect(await store.get("not-a-uuid")).toBeNull();
    expect(Object.keys(await store.archive(id, new Date()))).toEqual(["k1", "k2"]);
    expect(await store.list()).toEqual([]);
    expect((await store.list({ includeArchived: true }))[0]).toMatchObject({ status: "archived", pool: {} });

    for (const action of ["video.produce", "video.revise", "video.rerender", "video.export", "video.archive"]) expect(ctx.server.actions.executors[action], action).toBeDefined();
    // Approved like any other video action: the vertical's default (draft).
    const revised = await ctx.server.actions.propose({ vertical: "openv", actionType: "video.produce", summary: "Trace demo", payload: { spec: { ...spec, voice: { provider: "silent" } } } });
    expect(revised.status).toBe("pending");
    const done = (await ctx.server.actions.approve(revised.id)) as any;
    const projectId = done.result.result.projectId as string;
    const proposal = await ctx.server.actions.propose({ vertical: "openv", actionType: "video.revise", summary: "Shorter hook", payload: { projectId, patch: { scenes: [{ op: "update", id: "hook", set: { heading: "Trace it" } }] } } });
    expect(proposal).toMatchObject({ status: "pending", policy: "draft" });
    expect(proposal.summary).toMatch(/^Shorter hook \[r1 → r2: hook: heading\. Re-renders/);
    await expect(ctx.server.actions.propose({ vertical: "openv", actionType: "video.revise", summary: "x", payload: { projectId, patch: { scenes: [{ op: "remove", id: "nope" }] } } })).rejects.toThrow(/no scene "nope"/);
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
