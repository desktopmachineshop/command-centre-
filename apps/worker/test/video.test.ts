import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "@cc/core";
import { BRANDS, type VideoSpecInput } from "@cc/video";
import { playwrightRecorderInstalled } from "@cc/video/node";
import { sampleSpec, serveSample } from "@cc/video/sample";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultRegistry, detectCapabilities, HandlerRegistry, type JobContext, videoCaptureHandler, videoRenderHandler } from "../src";

const fakeFfmpeg = fileURLToPath(new URL("./fixtures/fake-ffmpeg.mjs", import.meta.url));
const CHROMIUM = playwrightRecorderInstalled()
  ? (process.env.CC_CHROMIUM_BIN ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null))
  : null;

function job(kind: string, payload: Record<string, unknown>): Job {
  const now = new Date().toISOString();
  return { id: "job-1", kind, requires: [], payload, status: "assigned", nodeId: "n", progress: null, result: null, createdAt: now, updatedAt: now };
}
function context(j: Job, progress: [number, string?][] = []): JobContext {
  return { job: j, dir: mkdtempSync(join(tmpdir(), "cc-video-")), signal: new AbortController().signal, progress: (p, m) => progress.push([p, m]) };
}

/** Serves fake assets and records PUT uploads. */
let server: Server;
let base = "";
const uploads: { path: string; bytes: number; type?: string }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "PUT") {
      let bytes = 0;
      req.on("data", (c: Buffer) => (bytes += c.length));
      req.on("end", () => {
        uploads.push({ path: req.url!, bytes, type: req.headers["content-type"] });
        res.writeHead(200).end();
      });
      return;
    }
    if (req.url === "/missing.webm") return void res.writeHead(404).end();
    res.writeHead(200).end(`asset ${req.url}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const spec = (scenes: VideoSpecInput["scenes"], extra: Partial<VideoSpecInput> = {}): VideoSpecInput => ({
  id: "promo",
  title: "Promo",
  product: "openv",
  type: "short",
  format: "9:16",
  brand: { ...BRANDS.openv, logoUrl: `${base}/logo.png` },
  scenes,
  ...extra,
});

const registry = () => new HandlerRegistry().register(videoRenderHandler({ ffmpegBin: fakeFfmpeg })).register(videoCaptureHandler({ ffmpegBin: fakeFfmpeg }));

describe("video.render", () => {
  it("downloads assets, voices locally, builds the compositor command and uploads the MP4", async () => {
    const progress: [number, string?][] = [];
    const payload = {
      spec: spec([
        { id: "hook", kind: "title", heading: "Requirements, traced", narration: "Trace every requirement." },
        { id: "demo", kind: "capture", steps: [{ action: "goto", url: "https://app.openv.example/" }], narration: "Open the project map." },
        { id: "cta", kind: "outro", heading: "OpenV", cta: "Try it free" },
      ]),
      assets: { demo: { url: `${base}/clips/demo.webm`, trimStartSec: 0.4, durationSec: 5 } },
      encoder: "cpu",
      preset: "veryfast",
      upload: { putUrl: `${base}/put/promo.mp4?sig=abc`, publicUrl: "https://media.example/promo.mp4" },
    };
    const ctx = context(job("video.render", payload), progress);
    const result = (await registry().run(ctx)) as Record<string, unknown>;

    expect(result).toMatchObject({ width: 1080, height: 1920, encoder: "libx264", url: "https://media.example/promo.mp4" });
    expect(result.outputPath).toBe(join(ctx.dir, "promo.mp4"));
    // The fake ffmpeg writes its argv into the output file.
    const argv = JSON.parse(readFileSync(join(ctx.dir, "promo.mp4"), "utf8")) as string[];
    expect(argv).toEqual(expect.arrayContaining(["-ss", "0.4", "-i", "clip-demo.webm", "-i", "logo.png", "-i", "voice-hook.wav", "-i", "voice-demo.wav", "-preset", "veryfast"]));
    expect(argv[argv.indexOf("-filter_complex") + 1]).toContain("subtitles=filename=captions.ass");
    expect(readFileSync(join(ctx.dir, "clip-demo.webm"), "utf8")).toBe("asset /clips/demo.webm");
    expect(readFileSync(join(ctx.dir, "captions.srt"), "utf8")).toContain("Trace every");
    expect(uploads.at(-1)).toMatchObject({ path: "/put/promo.mp4?sig=abc", type: "video/mp4" });
    expect(progress.at(-1)![0]).toBeGreaterThan(0.5);
  });

  it("uses NVENC on GPU nodes and falls back to x264 when it fails", async () => {
    const payload = { spec: spec([{ id: "hook", kind: "title", heading: "Hi" }]) };
    const gpu = new HandlerRegistry().register(videoRenderHandler({ ffmpegBin: fakeFfmpeg, gpu: true }));
    const ctx = context(job("video.render", payload));
    expect(await gpu.run(ctx)).toMatchObject({ encoder: "h264_nvenc" });

    process.env.FAKE_FFMPEG_EXIT = "1";
    try {
      await expect(gpu.run(context(job("video.render", payload)))).rejects.toThrow(/ffmpeg exited with code 1/);
    } finally {
      delete process.env.FAKE_FFMPEG_EXIT;
    }
  });

  it("rejects bad payloads before doing anything", async () => {
    const run = (payload: Record<string, unknown>) => registry().run(context(job("video.render", payload)));
    const title: VideoSpecInput["scenes"] = [{ id: "hook", kind: "title", heading: "Hi" }];
    await expect(run({ spec: spec(title), outputName: "../../evil.mp4" })).rejects.toThrow(/Invalid video.render payload/);
    await expect(run({ spec: spec([{ id: "x", kind: "capture", steps: [{ action: "goto", url: "file:///C:/Users/dave/secret.html" }] }]) })).rejects.toThrow(/Invalid video.render payload/);
    await expect(run({ spec: spec(title), assets: { hook: { url: "file:///etc/passwd" } } })).rejects.toThrow(/Invalid video.render payload/);
    await expect(run({ spec: spec(title, { brand: { ...BRANDS.openv, logoUrl: "ftp://x/logo.png" } }) })).rejects.toThrow(/Invalid video.render payload/);
  });

  it("explains what is missing: recordings, server-side voices, broken downloads", async () => {
    const run = (payload: Record<string, unknown>) => registry().run(context(job("video.render", payload)));
    const capture = [{ id: "demo", kind: "capture", steps: [{ action: "goto", url: "https://x.example/" }] }] as VideoSpecInput["scenes"];
    await expect(run({ spec: spec(capture) })).rejects.toThrow(/No recording for capture scene\(s\) demo/);
    await expect(run({ spec: spec(capture), captureInline: true })).rejects.toThrow(/captureInline needs a browser/);
    await expect(run({ spec: spec(capture), assets: { demo: { url: `${base}/missing.webm` } } })).rejects.toThrow(/Download failed \(404\)/);
    await expect(
      run({ spec: spec([{ id: "hook", kind: "title", heading: "Hi", narration: "Hello" }], { voice: { provider: "elevenlabs" } }) }),
    ).rejects.toThrow(/runs on the server/);
  });
});

describe("video.capture", () => {
  it("needs a configured browser", async () => {
    const payload = { spec: spec([{ id: "demo", kind: "capture", steps: [{ action: "goto", url: "https://x.example/" }] }]) };
    await expect(registry().run(context(job("video.capture", payload)))).rejects.toThrow(/No browser configured/);
    const noCapture = { spec: spec([{ id: "hook", kind: "title", heading: "Hi" }]) };
    const withBrowser = new HandlerRegistry().register(videoCaptureHandler({ ffmpegBin: fakeFfmpeg, chromiumBin: "/nonexistent/chrome" }));
    await expect(withBrowser.run(context(job("video.capture", noCapture)))).rejects.toThrow(/no capture scenes/);
    await expect(withBrowser.run(context(job("video.capture", { ...payload, scenes: ["nope"] })))).rejects.toThrow(/Not capture scenes in this spec: nope/);
  });

  it.skipIf(!CHROMIUM)("records the requested scenes and uploads them", async () => {
    const site = await serveSample();
    try {
      const sample = sampleSpec(site.url);
      const handler = new HandlerRegistry().register(videoCaptureHandler({ ffmpegBin: fakeFfmpeg, chromiumBin: CHROMIUM! }));
      const ctx = context(
        job("video.capture", { spec: sample, scenes: ["open-topic"], uploads: { "open-topic": { putUrl: `${base}/put/open-topic.webm`, publicUrl: "https://media.example/open-topic.webm" } } }),
      );
      const result = (await handler.run(ctx)) as { clips: Record<string, { file: string; url?: string; durationSec: number }> };
      expect(Object.keys(result.clips)).toEqual(["open-topic"]);
      expect(result.clips["open-topic"]).toMatchObject({ file: "open-topic.webm", url: "https://media.example/open-topic.webm" });
      expect(result.clips["open-topic"]!.durationSec).toBeGreaterThan(2);
      expect(uploads.at(-1)).toMatchObject({ path: "/put/open-topic.webm", type: "video/webm" });
      expect(uploads.at(-1)!.bytes).toBeGreaterThan(10_000);
    } finally {
      await site.close();
    }
  });
});

describe("registry and capabilities", () => {
  it("registers the video kinds and detects the browser from config", async () => {
    const kinds = defaultRegistry({ ffmpegBin: fakeFfmpeg, claudeBin: "claude-not-installed", claudeDirs: [], workDir: tmpdir() }).kinds();
    expect(kinds).toEqual(expect.arrayContaining(["video.capture", "video.render"]));
    const caps = (chromiumBin: string | null) => detectCapabilities({ ffmpegBin: "nope", claudeBin: "nope", chromiumBin, env: { PATH: "" }, platform: "linux" });
    expect(await caps(null)).not.toContain("browser");
    expect(await caps(fakeFfmpeg)).toContain("browser");
    expect(await caps("/nonexistent/chrome")).not.toContain("browser");
  });
});
