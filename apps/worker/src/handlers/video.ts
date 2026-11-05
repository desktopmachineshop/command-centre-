import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type CaptureScene,
  type Upload,
  VideoCapturePayload,
  type VideoCaptureResult,
  VideoRenderPayload,
  type VideoRenderResult,
  type VideoSpec,
  silentProvider,
  type TextToSpeech,
} from "@cc/video";
import { captureScenes, ffmpegHas, fliteProvider, renderVideo, type VoiceFile } from "@cc/video/node";
import { defineHandler, JobError } from "./registry";

/**
 * `video.capture` (needs `browser`) and `video.render` (needs `ffmpeg`; uses
 * NVENC when the node has a `gpu`). Payloads are VideoSpecs validated by
 * @cc/video: pages are http(s) only, file names are plain, every ffmpeg
 * argument is built here by the compositor, and nothing runs through a shell.
 */

export interface VideoHandlerOptions {
  ffmpegBin: string;
  /** Chromium/Chrome for capture; without it capture fails with a clear error. */
  chromiumBin?: string;
  /** Signed-in browser profiles (Playwright storage-state files) by name. */
  captureProfiles?: Record<string, string>;
  /** The node has a GPU: `encoder: auto` tries NVENC first. */
  gpu?: boolean;
  fetch?: typeof fetch;
}

/** Largest file a job will download (recordings, images, music). */
const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3;

export async function download(url: string, dest: string, signal: AbortSignal, http: typeof fetch): Promise<void> {
  const res = await http(url, { signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new JobError(`Download failed (${res.status}) for ${new URL(url).host}`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > MAX_DOWNLOAD_BYTES ? new JobError(`Download over ${MAX_DOWNLOAD_BYTES} bytes`) : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), limit, createWriteStream(dest));
}

/** A safe extension from a URL path (letters and digits only), or the fallback. */
function extFrom(url: string, fallback: string): string {
  const ext = extname(new URL(url).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : fallback;
}

const CONTENT_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".srt": "application/x-subrip" };

async function upload(path: string, target: Upload, signal: AbortSignal, http: typeof fetch): Promise<string> {
  const size = (await stat(path)).size;
  const res = await http(target.putUrl, {
    method: "PUT",
    headers: { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream", "content-length": String(size) },
    body: Readable.toWeb(createReadStream(path)) as never,
    duplex: "half",
    signal,
  } as RequestInit);
  if (!res.ok) throw new JobError(`Upload failed (${res.status}) to ${new URL(target.putUrl).host}`);
  return target.publicUrl;
}

function captureScenesOf(spec: VideoSpec, only?: string[]): CaptureScene[] {
  const scenes = spec.scenes.filter((s): s is CaptureScene => s.kind === "capture");
  if (!only) return scenes;
  const unknown = only.filter((id) => !scenes.some((s) => s.id === id));
  if (unknown.length) throw new JobError(`Not capture scenes in this spec: ${unknown.join(", ")}`);
  return scenes.filter((s) => only.includes(s.id));
}

export function videoCaptureHandler(options: VideoHandlerOptions) {
  const http = options.fetch ?? fetch;
  return defineHandler({
    kind: "video.capture",
    payload: VideoCapturePayload,
    async run(payload, ctx): Promise<VideoCaptureResult> {
      if (!options.chromiumBin) throw new JobError("No browser configured on this worker: set chromiumBin in worker.json (or CC_CHROMIUM_BIN)");
      const scenes = captureScenesOf(payload.spec, payload.scenes);
      if (!scenes.length) throw new JobError("This spec has no capture scenes");
      const totalSteps = scenes.reduce((n, s) => n + s.steps.length, 0);
      let done = 0;
      let results;
      try {
        results = await captureScenes(scenes, {
          dir: ctx.dir,
          format: payload.spec.format,
          brand: payload.spec.brand,
          executablePath: options.chromiumBin,
          profiles: options.captureProfiles,
          signal: ctx.signal,
          onStep: (_i, step) => ctx.progress((0.9 * ++done) / totalSteps, `capture: ${step.action}`),
        });
      } catch (err) {
        throw new JobError((err as Error).message);
      }
      const clips: VideoCaptureResult["clips"] = {};
      for (const [id, clip] of Object.entries(results)) {
        const target = payload.uploads?.[id];
        clips[id] = { ...clip, ...(target ? { url: await upload(clip.path, target, ctx.signal, http) } : {}) };
      }
      return { clips };
    },
  });
}

export function videoRenderHandler(options: VideoHandlerOptions) {
  const http = options.fetch ?? fetch;
  return defineHandler({
    kind: "video.render",
    payload: VideoRenderPayload,
    async run(payload, ctx): Promise<VideoRenderResult> {
      const { spec } = payload;
      const dir = ctx.dir;
      ctx.progress(0, "fetching assets");

      // --- visuals: recordings (downloaded, or captured here) and images ---
      const visuals: Parameters<typeof renderVideo>[0]["visuals"] = {};
      const captures = captureScenesOf(spec);
      const missing = captures.filter((s) => !payload.assets[s.id]);
      if (missing.length && !payload.captureInline) {
        throw new JobError(`No recording for capture scene(s) ${missing.map((s) => s.id).join(", ")}: run video.capture first or set captureInline`);
      }
      if (missing.length) {
        if (!options.chromiumBin) throw new JobError("captureInline needs a browser: set chromiumBin in worker.json");
        try {
          const clips = await captureScenes(missing, { dir, format: spec.format, brand: spec.brand, executablePath: options.chromiumBin, profiles: options.captureProfiles, signal: ctx.signal });
          for (const [id, c] of Object.entries(clips)) visuals[id] = { kind: "video", file: c.file, trimStartSec: c.trimStartSec, durationSec: c.durationSec };
        } catch (err) {
          throw new JobError((err as Error).message);
        }
      }
      for (const [id, asset] of Object.entries(payload.assets)) {
        if (!captures.some((s) => s.id === id)) throw new JobError(`asset "${id}" is not a capture scene`);
        const file = `clip-${id}${extFrom(asset.url, ".webm")}`;
        await download(asset.url, join(dir, file), ctx.signal, http);
        visuals[id] = { kind: "video", file, trimStartSec: asset.trimStartSec, durationSec: asset.durationSec };
      }
      for (const scene of spec.scenes) {
        if (scene.kind !== "image") continue;
        const file = `image-${scene.id}${extFrom(scene.url, ".png")}`;
        await download(scene.url, join(dir, file), ctx.signal, http);
        visuals[scene.id] = { kind: "image", file };
      }
      let logoFile: string | undefined;
      if (spec.brand.logoUrl) {
        logoFile = `logo${extFrom(spec.brand.logoUrl, ".png")}`;
        await download(spec.brand.logoUrl, join(dir, logoFile), ctx.signal, http);
      }
      let musicFile: string | undefined;
      if (spec.music) {
        musicFile = `music${extFrom(spec.music.url, ".mp3")}`;
        await download(spec.music.url, join(dir, musicFile), ctx.signal, http);
      }

      // --- voice: server-made narration, else a local provider ---
      const voices: Record<string, VoiceFile> = {};
      for (const [id, v] of Object.entries(payload.voice)) {
        const file = `voice-${id}.${v.format}`;
        await download(v.url, join(dir, file), ctx.signal, http);
        voices[id] = { file, durationSec: v.durationSec, words: v.words };
      }
      const needsVoice = spec.scenes.some((s) => s.narration && !voices[s.id]);
      let tts: TextToSpeech | undefined;
      if (needsVoice) {
        if (spec.voice.provider === "silent") tts = silentProvider();
        else if (spec.voice.provider === "flite") {
          tts = (await ffmpegHas(options.ffmpegBin, "filters", "flite")) ? fliteProvider({ ffmpegBin: options.ffmpegBin, dir: join(dir, "tts") }) : silentProvider();
        } else {
          throw new JobError(`Voice provider "${spec.voice.provider}" runs on the server: send the narration in payload.voice`);
        }
      }

      // --- render, with NVENC first on GPU nodes ---
      const wantGpu = payload.encoder === "gpu" || (payload.encoder === "auto" && options.gpu === true);
      const attempt = (encoder: "libx264" | "h264_nvenc") =>
        renderVideo({
          spec,
          dir,
          ffmpegBin: options.ffmpegBin,
          visuals,
          voices,
          tts,
          logoFile,
          musicFile,
          encoder,
          preset: encoder === "libx264" ? payload.preset : undefined,
          outputName: payload.outputName,
          signal: ctx.signal,
          onProgress: (f, m) => ctx.progress(0.1 + 0.85 * f, m),
        });
      let out;
      try {
        try {
          out = await attempt(wantGpu ? "h264_nvenc" : "libx264");
        } catch (err) {
          if (!(wantGpu && payload.encoder === "auto")) throw err;
          ctx.progress(0.1, "NVENC failed; rendering on the CPU");
          out = await attempt("libx264");
        }
      } catch (err) {
        throw new JobError((err as Error).message);
      }

      const url = payload.upload ? await upload(out.outputPath, payload.upload, ctx.signal, http) : undefined;
      return {
        outputPath: out.outputPath,
        bytes: out.bytes,
        durationSec: out.durationSec,
        width: out.width,
        height: out.height,
        encoder: out.encoder,
        captionsPath: out.srtPath,
        ...(url ? { url } : {}),
      };
    },
  });
}
