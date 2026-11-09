import { z } from "zod";
import { VideoSpec } from "./spec";

/**
 * Payloads of the worker's `video.capture` and `video.render` jobs, shared by
 * the server (which submits them) and the worker (which validates them).
 */

const HttpUrl = z.url({ protocol: /^https?$/ });
const SceneId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** Where to put a finished file: the worker PUTs it to `putUrl`; `publicUrl` is where it is then served. */
export const Upload = z.object({ putUrl: HttpUrl, publicUrl: HttpUrl });
export type Upload = z.infer<typeof Upload>;

const Word = z.object({ word: z.string().max(100), start: z.number().min(0), end: z.number().min(0) });

/** Server-side bookkeeping carried through the job and back in the result; the worker ignores it. */
const Meta = z.record(z.string(), z.unknown()).optional();

export const VideoCapturePayload = z.object({
  spec: VideoSpec,
  /** Capture only these scenes (default: every capture scene). */
  scenes: z.array(SceneId).max(40).optional(),
  /** Upload each recording here once it is made. */
  uploads: z.record(SceneId, Upload).optional(),
  meta: Meta,
});
export type VideoCapturePayload = z.infer<typeof VideoCapturePayload>;

export const CapturedClip = z.object({
  file: z.string(),
  path: z.string(),
  bytes: z.number(),
  trimStartSec: z.number(),
  durationSec: z.number(),
  url: HttpUrl.optional(),
});
export type CapturedClip = z.infer<typeof CapturedClip>;
export const VideoCaptureResult = z.object({ clips: z.record(z.string(), CapturedClip) });
export type VideoCaptureResult = z.infer<typeof VideoCaptureResult>;

export const VideoRenderPayload = z.object({
  spec: VideoSpec,
  /** Recordings for capture scenes, from an earlier `video.capture` job. */
  assets: z.record(SceneId, z.object({ url: HttpUrl, trimStartSec: z.number().min(0).max(60).default(0), durationSec: z.number().min(0).optional() })).default({}),
  /**
   * Narration synthesised by the server (cloud TTS). Scenes without an entry
   * are voiced on the worker, which only runs the local providers (silent, flite).
   */
  voice: z
    .record(SceneId, z.object({ url: HttpUrl, format: z.enum(["wav", "mp3"]), durationSec: z.number().positive(), words: z.array(Word).max(5000) }))
    .default({}),
  /** Capture the screen scenes in this job too (the node needs `browser` as well as `ffmpeg`). */
  captureInline: z.boolean().default(false),
  outputName: z
    .string()
    .regex(/^[\w][\w.-]{0,150}\.mp4$/, "a plain .mp4 file name")
    .refine((n) => !n.includes(".."), "a plain .mp4 file name")
    .optional(),
  /** auto: NVENC when the node has a GPU (falling back to x264 if it fails), else x264. */
  encoder: z.enum(["auto", "cpu", "gpu"]).default("auto"),
  preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"]).optional(),
  upload: Upload.optional(),
  /**
   * Where to put narration the worker synthesises itself (flite), per scene, so the project keeps
   * it and the next render doesn't make it again.
   */
  voiceUploads: z.record(SceneId, Upload).optional(),
  /** Where to put the captions (SRT). */
  captionsUpload: Upload.optional(),
  /**
   * Also render each scene as its own clip (picture only, card text included, no captions) and
   * upload it here: the clips of an editable timeline (video.export).
   */
  stemUploads: z.record(SceneId, Upload).optional(),
  /** With stemUploads: only the per-scene clips, no finished video. */
  stemsOnly: z.boolean().default(false),
  meta: Meta,
});
export type VideoRenderPayload = z.infer<typeof VideoRenderPayload>;
export type VideoRenderPayloadInput = z.input<typeof VideoRenderPayload>;

export const VideoRenderResult = z.object({
  outputPath: z.string(),
  bytes: z.number(),
  durationSec: z.number(),
  width: z.number(),
  height: z.number(),
  encoder: z.string(),
  captionsPath: z.string().nullable(),
  url: HttpUrl.optional(),
  /** Narration the worker made and uploaded (voiceUploads), per scene. */
  voice: z.record(z.string(), z.object({ url: HttpUrl, format: z.enum(["wav", "mp3"]), durationSec: z.number().positive(), words: z.array(Word).max(5000) })).optional(),
  captionsUrl: HttpUrl.optional(),
  /** Per-scene clips (stemUploads). */
  stems: z.record(z.string(), z.object({ url: HttpUrl, durationSec: z.number().positive() })).optional(),
  /** Where each scene sits in the render, for building an editable timeline from it. */
  timeline: z
    .object({
      total: z.number(),
      scenes: z.array(z.object({ id: z.string(), start: z.number(), duration: z.number(), voiceStart: z.number().nullable() })),
    })
    .optional(),
});
export type VideoRenderResult = z.infer<typeof VideoRenderResult>;
