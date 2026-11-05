import { randomUUID } from "node:crypto";
import type { Capability, Job, NewProposal, NotificationMedia } from "@cc/core";
import {
  cloudProvider,
  type FetchLike,
  LOCAL_PROVIDERS,
  lintSpec,
  estimateWordTimings,
  speechExt,
  type TtsKeys,
  type Upload,
  VideoCaptureResult,
  type VideoRenderPayloadInput,
  VideoRenderResult,
  VideoSpec,
} from "@cc/video";
import { ELEVENLABS_DEFAULT_VOICE, type VoiceProviderConfig } from "@cc/voice";
import { z } from "zod";
import type { ActionExecutor } from "./actions";

/**
 * `video.produce`: Dave approves a VideoSpec (written by an agent with the
 * video-reel skill), then this turns it into worker jobs:
 *
 *   [server TTS, if a cloud voice] → video.capture (browser) → video.render (ffmpeg, GPU optional)
 *     → social.campaign proposal (always held for approval) or a notification.
 *
 * Files move between stages through a media store (unguessable upload URLs).
 * Until one is configured, a single `video.render` job with `captureInline`
 * does capture and render on one PC, and Dave is told where the file is.
 * The chain is driven by job completions (`WorkerService.onJobSettled`), with
 * its state carried in each job's `payload.meta.production`.
 */

/**
 * Who a production's file belongs to: its vertical (spec.product), the production
 * ("video:<id>"), and whether it is work in progress (captures, narration), which is
 * deleted once the final render has been published.
 */
export interface MediaTags {
  vertical: string;
  work: string;
  wip: boolean;
}

/** Where workers upload files and from where social platforms fetch them. */
export interface VideoMediaStore {
  /** A one-off PUT URL for a worker, plus the public URL the file will have. */
  createUpload(name: string, contentType: string, tags?: MediaTags): Promise<Upload>;
  /** Stores bytes made on the server (narration) and returns their public URL. */
  put(name: string, bytes: Uint8Array, contentType: string, tags?: MediaTags): Promise<string>;
}

const tags = (spec: VideoSpec, productionId: string, wip: boolean): MediaTags => ({ vertical: spec.product, work: `video:${productionId}`, wip });

export interface VideoDeps {
  submit(job: { kind: string; requires: Capability[]; payload: Record<string, unknown> }): Promise<Job>;
  /** Proposes an action; `forceDraft` holds it for approval whatever the vertical's policy. */
  propose(proposal: NewProposal, options: { forceDraft: string }): Promise<unknown>;
  notify(n: { title: string; body: string; media?: NotificationMedia[] }): Promise<void>;
  /** Whether an action type has an executor (social.campaign is being built alongside). */
  hasAction(actionType: string): boolean;
  media?: VideoMediaStore;
  tts?: TtsKeys;
  fetch?: FetchLike;
}

export const VideoProducePayload = z.object({
  spec: VideoSpec,
  /** Accounts to post the finished video to, each with its own post text. */
  targets: z
    .array(
      z.object({
        accountId: z.string().min(1).max(100),
        text: z.string().min(1).max(5000),
        title: z.string().max(300).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(20)
    .default([]),
  publishAt: z.iso.datetime({ offset: true }).optional(),
  encoder: z.enum(["auto", "cpu", "gpu"]).default("auto"),
});
export type VideoProducePayload = z.infer<typeof VideoProducePayload>;

/**
 * Parses a video.produce payload, with an error an agent (or Dave) can act on
 * instead of zod's raw JSON issue list.
 */
export function parseProducePayload(raw: unknown): VideoProducePayload {
  const r = VideoProducePayload.safeParse(raw);
  if (r.success) return r.data;
  throw new Error(
    `video.produce payload is not a valid VideoSpec; write it as the video-reel skill shows (id, product "openv"|"opend"|"dms"|"3dpandme", type, format "9:16"|"16:9"|"1:1", brand, scenes with kind title|capture|slide|image|outro):\n${z.prettifyError(r.error)}`,
  );
}

/** What a job carries so the next stage can be submitted when it finishes. */
const Production = z.object({
  id: z.string(),
  stage: z.enum(["capture", "render"]),
  targets: VideoProducePayload.shape.targets,
  publishAt: z.string().optional(),
  encoder: VideoProducePayload.shape.encoder,
  voice: z.record(z.string(), z.unknown()).default({}),
});
type Production = z.infer<typeof Production>;

export class VideoProductions {
  constructor(private readonly deps: VideoDeps) {}

  executors(): Record<string, ActionExecutor> {
    return {
      "video.produce": {
        description:
          "Produce a product video from a VideoSpec (see the video-reel skill) on a desktop worker, then propose a social.campaign with it. " +
          "payload: { spec, targets?: [{ accountId, text, title? }], publishAt?, encoder? }",
        validate: (payload) => {
          parseProducePayload(payload);
        },
        execute: (payload) => this.start(payload),
      },
    };
  }

  /** Validates the request, voices it if needed and submits the first job. */
  async start(raw: Record<string, unknown>) {
    const input = parseProducePayload(raw);
    const { spec } = input;
    const id = randomUUID();
    const media = this.deps.media;
    const voice = await this.voice(spec, id);
    const production: Production = { id, stage: "capture", targets: input.targets, publishAt: input.publishAt, encoder: input.encoder, voice };
    const hasCapture = spec.scenes.some((s) => s.kind === "capture");
    const warnings = lintSpec(spec);

    if (media && hasCapture) {
      const uploads: Record<string, Upload> = {};
      for (const s of spec.scenes) if (s.kind === "capture") uploads[s.id] = await media.createUpload(`${spec.id}-${id}/${s.id}.webm`, "video/webm", tags(spec, id, true));
      const job = await this.deps.submit({ kind: "video.capture", requires: ["browser"], payload: { spec, uploads, meta: { production } } });
      return { productionId: id, captureJobId: job.id, warnings };
    }
    const render: VideoRenderPayloadInput = {
      spec,
      voice: voice as VideoRenderPayloadInput["voice"],
      captureInline: hasCapture,
      encoder: input.encoder,
      ...(media ? { upload: await media.createUpload(`${spec.id}-${id}/${spec.id}.mp4`, "video/mp4", tags(spec, id, false)) } : {}),
      meta: { production: { ...production, stage: "render" } },
    };
    const job = await this.deps.submit({ kind: "video.render", requires: hasCapture ? ["ffmpeg", "browser"] : ["ffmpeg"], payload: render as Record<string, unknown> });
    return { productionId: id, renderJobId: job.id, warnings };
  }

  /** Cloud voices are made here, where the keys are, and handed to the worker as files. */
  private async voice(spec: VideoSpec, id: string): Promise<Record<string, unknown>> {
    if (LOCAL_PROVIDERS.has(spec.voice.provider)) return {};
    const tts = cloudProvider(spec.voice.provider, this.deps.tts ?? {}, this.deps.fetch);
    if (!tts) throw new Error(`Voice provider "${spec.voice.provider}" is not configured on the server (set its API key), or use "silent"/"flite"`);
    if (!this.deps.media) throw new Error(`Voice provider "${spec.voice.provider}" needs a media store to hand the audio to the worker`);
    const out: Record<string, unknown> = {};
    for (const scene of spec.scenes) {
      if (!scene.narration) continue;
      const r = await tts.synthesize(scene.narration, { voiceId: spec.voice.voiceId, speed: spec.voice.speed });
      const format = speechExt(r.mime);
      const url = await this.deps.media.put(`${spec.id}-${id}/voice-${scene.id}.${format}`, r.audio, r.mime, tags(spec, id, true));
      out[scene.id] = { url, format, durationSec: r.durationSec, words: r.words ?? estimateWordTimings(scene.narration, r.durationSec) };
    }
    return out;
  }

  /** Moves a production on when one of its jobs finishes. Jobs without production meta are ignored. */
  async onJobSettled(job: Job): Promise<void> {
    if (job.kind !== "video.capture" && job.kind !== "video.render") return;
    const meta = (job.payload.meta as { production?: unknown } | undefined)?.production;
    const parsed = Production.safeParse(meta);
    if (!parsed.success) return;
    const production = parsed.data;
    const spec = VideoSpec.parse(job.payload.spec);

    if (job.status === "failed") {
      const error = (job.result as { error?: string } | null)?.error ?? "unknown error";
      await this.deps.notify({ title: `Video failed: ${spec.title}`, body: `${job.kind} failed: ${error}` });
      return;
    }
    if (job.status !== "succeeded") return;

    if (job.kind === "video.capture") {
      const result = VideoCaptureResult.parse(job.result);
      const assets: VideoRenderPayloadInput["assets"] = {};
      for (const [id, clip] of Object.entries(result.clips)) {
        if (!clip.url) {
          await this.deps.notify({ title: `Video stopped: ${spec.title}`, body: `The recording of "${id}" was not uploaded, so it can't be rendered elsewhere.` });
          return;
        }
        assets[id] = { url: clip.url, trimStartSec: clip.trimStartSec, durationSec: clip.durationSec };
      }
      const render: VideoRenderPayloadInput = {
        spec,
        assets,
        voice: production.voice as VideoRenderPayloadInput["voice"],
        encoder: production.encoder,
        ...(this.deps.media ? { upload: await this.deps.media.createUpload(`${spec.id}-${production.id}/${spec.id}.mp4`, "video/mp4", tags(spec, production.id, false)) } : {}),
        meta: { production: { ...production, stage: "render" } },
      };
      await this.deps.submit({ kind: "video.render", requires: ["ffmpeg"], payload: render as Record<string, unknown> });
      return;
    }

    const result = VideoRenderResult.parse(job.result);
    const where = result.url ?? `${result.outputPath} on worker ${job.nodeId ?? "?"}`;
    const length = `${Math.round(result.durationSec)}s ${result.width}x${result.height}`;
    // With a public URL, the notification carries the video so the app plays it in place.
    const media: NotificationMedia[] = result.url
      ? [{ url: result.url, type: "video", alt: spec.title, durationSec: result.durationSec, width: result.width, height: result.height }]
      : [];
    if (!production.targets.length) {
      await this.deps.notify({ title: `Video ready: ${spec.title}`, body: `${length}: ${where}`, media });
      return;
    }
    if (!result.url || !this.deps.hasAction("social.campaign")) {
      const why = !result.url ? "it has no public URL yet (no media store)" : "social.campaign is not available";
      await this.deps.notify({ title: `Video ready: ${spec.title}`, body: `${length}: ${where}. Not proposed for posting because ${why}.`, media });
      return;
    }
    await this.deps.propose(
      {
        vertical: spec.product,
        actionType: "social.campaign",
        summary: `Post video "${spec.title}" (${length}) to ${production.targets.map((t) => t.accountId).join(", ")}`,
        payload: {
          title: spec.title,
          posts: production.targets.map((t) => ({
            accountId: t.accountId,
            content: { text: t.text, ...(t.title ? { title: t.title } : {}), media: [{ url: result.url, type: "video", alt: spec.title }], ...(t.options ? { options: t.options } : {}) },
          })),
          ...(production.publishAt ? { publishAt: production.publishAt } : {}),
          video: { url: result.url, durationSec: result.durationSec, width: result.width, height: result.height, sources: spec.sources },
        },
      },
      { forceDraft: "a rendered video is always reviewed before it is posted" },
    );
  }
}

/**
 * Cloud TTS keys for video narration, from the voice settings in the loaded config
 * (`ELEVENLABS_API_KEY`, `VOICE_ELEVENLABS_VOICE`/`_TTS_MODEL`, `OPENAI_API_KEY`,
 * `VOICE_OPENAI_VOICE`/`_TTS_MODEL`); a provider is offered only once its key is set.
 */
export function videoTtsFromConfig(p: VoiceProviderConfig): TtsKeys {
  return {
    ...(p.elevenlabsApiKey
      ? { elevenlabs: { apiKey: p.elevenlabsApiKey, voiceId: p.elevenlabsVoice || ELEVENLABS_DEFAULT_VOICE, modelId: p.elevenlabsTtsModel || undefined } }
      : {}),
    ...(p.openaiApiKey ? { openai: { apiKey: p.openaiApiKey, model: p.openaiTtsModel || undefined, voice: p.openaiVoice || undefined } } : {}),
  };
}
