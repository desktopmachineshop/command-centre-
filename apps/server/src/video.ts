import { randomUUID } from "node:crypto";
import { type Capability, DavinciRenderPayload, type Job, type NewProposal, type NotificationMedia } from "@cc/core";
import {
  applyPatch,
  buildEditTimeline,
  cloudProvider,
  describeChanges,
  type FetchLike,
  FRAME,
  LOCAL_PROVIDERS,
  lintSpec,
  estimateWordTimings,
  pinCaptureViewports,
  planRevision,
  type RevisionPlan,
  SpecPatch,
  speechExt,
  toFcpxml,
  type TtsKeys,
  type Upload,
  VideoCaptureResult,
  type VideoRenderPayloadInput,
  VideoRenderResult,
  VideoSpec,
  wavDuration,
} from "@cc/video";
import { ELEVENLABS_DEFAULT_VOICE, type VoiceProviderConfig } from "@cc/voice";
import { findVoice, type LocalSpeech, LocalTextToSpeech, VOICES } from "@cc/voice/local";
import { z } from "zod";
import type { ActionExecutor } from "./actions";
import { MemoryVideoProjectStore, type RevisionRequest, type VideoAsset, type VideoExport, type VideoProject, type VideoProjectStore, type VideoRevision } from "./video-projects";

/**
 * Video productions as projects. `video.produce` (a VideoSpec written by an agent with the
 * video-reel skill, approved by Dave) starts a project; `video.revise` edits its spec and
 * renders again, re-using every asset whose inputs didn't change; `video.rerender` renders the
 * same spec again; `video.export` hands it to an editor as a timeline. Each run is a revision:
 *
 *   [server TTS for narration not in the pool] → video.capture (browser, only scenes not in the pool)
 *     → video.render (ffmpeg, GPU optional) → social.campaign proposal (always held) or a notification.
 *
 * What is re-used is decided by @cc/video's planRevision from content hashes; the project (specs,
 * asset manifest, history) is in the VideoProjectStore and the files in the media store. Without
 * a media store, one `video.render` job with `captureInline` does capture and render on one PC,
 * Dave is told where the file is, and nothing can be re-used. The chain is driven by job
 * completions (`WorkerService.onJobSettled`); a job carries its project and revision in
 * `payload.meta.production`.
 */

/**
 * Who a production's file belongs to: its vertical (spec.product) and the project
 * ("video:<id>"). Project files are not work in progress: they are what the next edit is made
 * from, and go when the project is archived.
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
  /** Deletes a file by its public URL (an archived project's assets). */
  remove?(url: string): Promise<boolean>;
}

const tags = (spec: VideoSpec, projectId: string): MediaTags => ({ vertical: spec.product, work: `video:${projectId}`, wip: false });

export interface VideoDeps {
  submit(job: { kind: string; requires: Capability[]; payload: Record<string, unknown> }): Promise<Job>;
  /** Proposes an action; `forceDraft` holds it for approval whatever the vertical's policy. */
  propose(proposal: NewProposal, options: { forceDraft: string }): Promise<unknown>;
  notify(n: { title: string; body: string; media?: NotificationMedia[] }): Promise<void>;
  /** Whether an action type has an executor (social.campaign is being built alongside). */
  hasAction(actionType: string): boolean;
  media?: VideoMediaStore;
  tts?: TtsKeys;
  /** The server's own voices (the ones chat and Drive mode speak with): voice.provider "local". */
  local?: Pick<LocalSpeech, "synthesize" | "installVoice" | "voice" | "ttsModel"> | null;
  fetch?: FetchLike;
  /** Where projects are kept (Postgres in the server; in memory otherwise). */
  projects?: VideoProjectStore;
  now?: () => Date;
}

/** Voice provider for the server's own voices, the same ones chat reads replies aloud with. */
export const SERVER_VOICE_PROVIDER = "local";
/** `voice.provider` that lets the server pick the most natural voice it has. */
export const AUTO_VOICE = "auto";

const Targets = z
  .array(
    z.object({
      accountId: z.string().min(1).max(100),
      text: z.string().min(1).max(5000),
      title: z.string().max(300).optional(),
      options: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .max(20)
  .default([]);
const Encoder = z.enum(["auto", "cpu", "gpu"]).default("auto");

export const VideoProducePayload = z.object({
  spec: VideoSpec,
  /** Accounts to post the finished video to, each with its own post text. */
  targets: Targets,
  publishAt: z.iso.datetime({ offset: true }).optional(),
  encoder: Encoder,
});
export type VideoProducePayload = z.infer<typeof VideoProducePayload>;

const ProjectId = z.uuid();
export const VideoRevisePayload = z.object({
  projectId: ProjectId,
  /** The edit (see SpecPatch in @cc/video). Empty with `fromRevision` rolls back to that revision. */
  patch: SpecPatch.default({}),
  /** Edit this revision instead of the latest (a rollback, or a branch from an earlier cut). */
  fromRevision: z.number().int().positive().optional(),
  /** On a format change, fit the existing screen recordings into the new frame instead of recording again. */
  keepCaptures: z.boolean().default(false),
  targets: Targets,
  publishAt: z.iso.datetime({ offset: true }).optional(),
  encoder: Encoder,
});
export const VideoRerenderPayload = z.object({
  projectId: ProjectId,
  revision: z.number().int().positive().optional(),
  encoder: Encoder,
  preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"]).optional(),
  targets: Targets,
  publishAt: z.iso.datetime({ offset: true }).optional(),
});
export const VideoExportPayload = z.object({
  projectId: ProjectId,
  revision: z.number().int().positive().optional(),
  /** "fcpxml": the timeline document and its media in storage. "resolve-draft": also opened in DaVinci Resolve on Dave's PC as a draft. */
  format: z.enum(["fcpxml", "resolve-draft"]),
});
export const VideoArchivePayload = z.object({ projectId: ProjectId });

const readable = <T>(schema: z.ZodType<T>, action: string, hint: string) => (raw: unknown): T => {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new Error(`${action} payload is not valid; ${hint}:\n${z.prettifyError(r.error)}`);
};

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
const parseRevise = readable(VideoRevisePayload, "video.revise", "it takes { projectId, patch: { set?, scenes?: [{ op: update|remove|add|move, … }], order? }, fromRevision?, keepCaptures? } (see the video-reel skill)");
const parseRerender = readable(VideoRerenderPayload, "video.rerender", "it takes { projectId, revision?, encoder?, preset? }");
const parseExport = readable(VideoExportPayload, "video.export", 'it takes { projectId, revision?, format: "fcpxml" | "resolve-draft" }');
const parseArchive = readable(VideoArchivePayload, "video.archive", "it takes { projectId }");

/** What a job carries so the next stage can be submitted when it finishes. */
const Production = z.object({
  /** The project. */
  id: z.string(),
  revision: z.number().int().positive().default(1),
  stage: z.enum(["capture", "render", "export"]),
  exportFormat: z.enum(["fcpxml", "resolve-draft"]).optional(),
  /** Narration made on the server for this revision, by scene (also in the project's pool). */
  voice: z.record(z.string(), z.unknown()).default({}),
  /** Jobs submitted before projects existed carried the request themselves: still honoured when they finish. */
  targets: Targets.optional(),
  publishAt: z.string().optional(),
  encoder: Encoder.optional(),
});
type Production = z.infer<typeof Production>;

type VoiceEntry = { url: string; format: "wav" | "mp3"; durationSec: number; words: { word: string; start: number; end: number }[] };

export class VideoProductions {
  readonly projects: VideoProjectStore;
  private readonly now: () => Date;

  constructor(private readonly deps: VideoDeps) {
    this.projects = deps.projects ?? new MemoryVideoProjectStore(deps.now);
    this.now = deps.now ?? (() => new Date());
  }

  executors(): Record<string, ActionExecutor> {
    return {
      "video.produce": {
        description:
          "Produce a product video from a VideoSpec (see the video-reel skill) on a desktop worker, then propose a social.campaign with it. It becomes a video project that video.revise can edit later. " +
          "payload: { spec, targets?: [{ accountId, text, title? }], publishAt?, encoder? }",
        validate: (payload) => {
          const { spec } = parseProducePayload(payload);
          // Caught when proposed, so the agent fixes the voice before Dave approves it.
          const problem = this.voiceProblem(this.resolveVoice(spec));
          if (problem) throw new Error(problem);
        },
        execute: (payload) => this.start(payload),
      },
      "video.revise": {
        description:
          "Change an existing video project and render it again WITHOUT regenerating what didn't change: only a scene whose narration changed is voiced again, only a capture scene whose steps changed is recorded again; text, captions, order, trims, music, brand and format only re-compose. Find the project with the video tools (list_video_projects, get_video_project). " +
          'payload: { projectId, patch: { set?: { title?, format?, brand?, captions?, music?, voice?, transition?, fps? }, scenes?: [{ op: "update", id, set: { narration?, heading?, … } } | { op: "remove", id } | { op: "add", scene, after?|before?|at? } | { op: "move", id, after?|before?|at? }], order?: [scene ids] }, fromRevision? (edit or roll back to an earlier revision), keepCaptures? (on a format change, fit the old recordings instead of recording again), targets?, publishAt?, encoder? }. The approval says what is re-used and what is redone.',
        validate: async (payload) => {
          await this.planRevise(payload);
        },
        prepare: async (payload) => {
          const { base, plan, changes, warnings } = await this.planRevise(payload);
          const { revisionPreview: _agent, ...rest } = payload;
          const what = changes.length ? changes.join("; ") : "no change to the spec";
          return {
            payload: { ...rest, revisionPreview: { from: base.revision, to: base.project.current + 1, changes, plan: plan.summary, voice: plan.voice, capture: plan.capture, renders: plan.compose, warnings } },
            note: `[r${base.revision} → r${base.project.current + 1}: ${what}. ${plan.summary}]`,
          };
        },
        execute: (payload) => this.revise(payload),
      },
      "video.rerender": {
        description: "Render a video project's spec again as it is (same pictures, voice and recordings), e.g. with another encoder or preset, or after a failed render. payload: { projectId, revision? (default the latest), encoder?, preset?, targets?, publishAt? }",
        validate: async (payload) => {
          const p = parseRerender(payload);
          await this.revisionOf(p.projectId, p.revision);
        },
        execute: (payload) => this.rerender(payload),
      },
      "video.export": {
        description:
          'Hand a video project to an editor as a timeline instead of a flattened MP4: one clip per scene on the video track (title and end cards as their own clips), each scene\'s narration on an audio track under it, the music on another, captions as an SRT beside it. format "fcpxml" stores the FCPXML document and its media; "resolve-draft" also opens it in DaVinci Resolve on Dave\'s PC as a draft timeline for him to edit and render. payload: { projectId, revision?, format }',
        validate: async (payload) => {
          const p = parseExport(payload);
          await this.revisionOf(p.projectId, p.revision);
          if (!this.deps.media) throw new Error("video.export needs a media store (PUBLIC_BASE_URL) for the timeline's clips");
        },
        execute: (payload) => this.export(payload),
      },
      "video.archive": {
        description: "Archive a finished video project: its stored recordings and narration are deleted to free space (the rendered videos stay until their own retention), and it can no longer be revised. payload: { projectId }",
        validate: async (payload) => {
          await this.projectOf(parseArchive(payload).projectId);
        },
        execute: (payload) => this.archive(parseArchive(payload).projectId),
      },
    };
  }

  // ---- starting a revision ----

  /** A new project from a spec: its first revision. */
  async start(raw: Record<string, unknown>) {
    const input = parseProducePayload(raw);
    const spec = this.resolveVoice(input.spec);
    const problem = this.voiceProblem(spec);
    if (problem) throw new Error(problem);
    const project = await this.projects.create({ id: randomUUID(), vertical: spec.product, specId: spec.id, title: spec.title });
    return this.run(project, null, spec, { targets: input.targets, publishAt: input.publishAt, encoder: input.encoder }, ["created"]);
  }

  /** The base revision, the edited spec and what producing it would take. */
  private async planRevise(raw: Record<string, unknown>) {
    const p = parseRevise(raw);
    const base = await this.revisionOf(p.projectId, p.fromRevision);
    let spec: VideoSpec;
    try {
      spec = applyPatch(base.spec, p.patch);
    } catch (err) {
      if (err instanceof z.ZodError) throw new Error(`The patch does not leave a valid VideoSpec:\n${z.prettifyError(err)}`);
      throw err;
    }
    if (p.keepCaptures) spec = pinCaptureViewports(base.spec, spec);
    spec = this.resolveVoice(spec);
    const problem = this.voiceProblem(spec);
    if (problem) throw new Error(problem);
    const latest = base.revision === base.project.current ? base : await this.revisionOf(p.projectId);
    const changes = describeChanges(latest.spec, spec);
    const plan = this.plan(base.project, spec, latest, { encoder: p.encoder });
    return { p, base, spec, plan, changes: base.revision === latest.revision ? changes : [`back to r${base.revision}`, ...describeChanges(base.spec, spec)], warnings: lintSpec(spec) };
  }

  async revise(raw: Record<string, unknown>) {
    const { p, base, spec, changes } = await this.planRevise(raw);
    return this.run(base.project, base.revision, spec, { targets: p.targets, publishAt: p.publishAt, encoder: p.encoder }, changes);
  }

  async rerender(raw: Record<string, unknown>) {
    const p = parseRerender(raw);
    const base = await this.revisionOf(p.projectId, p.revision);
    return this.run(base.project, base.revision, base.spec, { targets: p.targets, publishAt: p.publishAt, encoder: p.encoder, ...(p.preset ? { preset: p.preset } : {}) }, [`rendered r${base.revision} again`], true);
  }

  private plan(project: VideoProject, spec: VideoSpec, rendered: VideoRevision | null, request: Pick<RevisionRequest, "encoder" | "preset">, force = false): RevisionPlan {
    return planRevision({
      spec,
      // Without a media store nothing was kept, whatever the pool says.
      pool: this.deps.media ? Object.keys(project.pool) : [],
      renderedComposeKey: rendered?.status === "ready" && rendered.outputs.video ? rendered.composeKey : null,
      voiceSalt: this.voiceSalt(spec),
      output: { ...(request.encoder !== "auto" ? { encoder: request.encoder } : {}), ...(request.preset ? { preset: request.preset } : {}) },
      force,
    });
  }

  /** Records the revision, makes what it needs and submits its first job. */
  private async run(project: VideoProject, basedOn: number | null, spec: VideoSpec, request: RevisionRequest, changes: string[], force = false) {
    const media = this.deps.media;
    const latest = project.current ? await this.projects.revision(project.id, project.current) : null;
    const plan = this.plan(project, spec, latest, request, force);
    const warnings = lintSpec(spec);
    const number = project.current + 1;
    if (spec.title !== project.title) await this.projects.setTitle(project.id, spec.title);

    if (!plan.compose && latest) {
      // Only what isn't drawn changed (title, sources): a new revision with the same render.
      await this.projects.addRevision(project.id, { revision: number, basedOn, spec, assets: plan.assets, composeKey: plan.composeKey, changes, plan: plan.summary, status: "ready", outputs: { ...latest.outputs, exports: [] }, request });
      return { projectId: project.id, revision: number, rendered: false, video: latest.outputs.video?.url ?? null, plan: plan.summary, warnings };
    }
    await this.projects.addRevision(project.id, { revision: number, basedOn, spec, assets: plan.assets, composeKey: plan.composeKey, changes, plan: plan.summary, status: "producing", outputs: {}, request });

    try {
      // Narration the server makes (cloud or its own voices), only for scenes not already in the pool.
      if (!LOCAL_PROVIDERS.has(spec.voice.provider)) await this.voice(project.id, number, spec, plan);
      const pool = (await this.projects.get(project.id))!.pool;
      const voice = this.voiceEntries(spec, plan, pool);
      const production: Production = { id: project.id, revision: number, stage: "capture", voice };

      if (media && plan.capture.make.length) {
        const uploads: Record<string, Upload> = {};
        for (const id of plan.capture.make) uploads[id] = await media.createUpload(`${spec.id}-${project.id}/r${number}/${id}.webm`, "video/webm", tags(spec, project.id));
        const job = await this.deps.submit({ kind: "video.capture", requires: ["browser"], payload: { spec, scenes: plan.capture.make, uploads, meta: { production } } });
        return { productionId: project.id, projectId: project.id, revision: number, captureJobId: job.id, plan: plan.summary, warnings };
      }
      const job = await this.submitRender(project.id, number, spec, plan, request, voice);
      return { productionId: project.id, projectId: project.id, revision: number, renderJobId: job.id, plan: plan.summary, warnings };
    } catch (err) {
      await this.projects.updateRevision(project.id, number, { status: "failed", error: (err as Error).message });
      throw err;
    }
  }

  /** The render job for a revision, from the assets in the pool. */
  private async submitRender(projectId: string, revision: number, spec: VideoSpec, plan: Pick<RevisionPlan, "assets">, request: Pick<RevisionRequest, "encoder" | "preset">, voice: Record<string, VoiceEntry>, stage: "render" | "export" = "render", exportFormat?: VideoExport["format"]) {
    const media = this.deps.media;
    const pool = (await this.projects.get(projectId))!.pool;
    const assets: NonNullable<VideoRenderPayloadInput["assets"]> = {};
    const missing: string[] = [];
    for (const scene of spec.scenes) {
      if (scene.kind !== "capture") continue;
      const asset = pool[plan.assets[scene.id]?.capture ?? ""];
      if (asset?.kind === "capture") assets[scene.id] = { url: asset.url, trimStartSec: asset.trimStartSec ?? 0, ...(asset.durationSec !== undefined ? { durationSec: asset.durationSec } : {}) };
      else missing.push(scene.id);
    }
    const dir = `${spec.id}-${projectId}/r${revision}`;
    const t = tags(spec, projectId);
    // Narration the worker will make itself (flite) comes back to the pool; silence isn't worth keeping.
    const voiceUploads: Record<string, Upload> = {};
    if (media && spec.voice.provider !== "silent") {
      for (const scene of spec.scenes) if (scene.narration && !voice[scene.id]) voiceUploads[scene.id] = await media.createUpload(`${dir}/voice-${scene.id}.wav`, "audio/wav", t);
    }
    const stemUploads: Record<string, Upload> = {};
    if (media && stage === "export") {
      for (const [i, scene] of spec.scenes.entries()) stemUploads[scene.id] = await media.createUpload(`${dir}/edit/${String(i + 1).padStart(2, "0")}-${scene.id}.mp4`, "video/mp4", t);
    }
    const render: VideoRenderPayloadInput = {
      spec,
      assets,
      voice,
      captureInline: missing.length > 0,
      encoder: request.encoder,
      ...(request.preset ? { preset: request.preset as VideoRenderPayloadInput["preset"] } : {}),
      ...(media && stage === "render" ? { upload: await media.createUpload(`${dir}/${spec.id}.mp4`, "video/mp4", t) } : {}),
      ...(Object.keys(voiceUploads).length ? { voiceUploads } : {}),
      ...(media && spec.captions.enabled ? { captionsUpload: await media.createUpload(`${dir}/${spec.id}.srt`, "application/x-subrip", t) } : {}),
      ...(stage === "export" ? { stemUploads, stemsOnly: true } : {}),
      meta: { production: { id: projectId, revision, stage, voice, ...(exportFormat ? { exportFormat } : {}) } satisfies Production },
    };
    return this.deps.submit({ kind: "video.render", requires: missing.length ? ["ffmpeg", "browser"] : ["ffmpeg"], payload: render as Record<string, unknown> });
  }

  // ---- voices ----

  /** `voice.provider: "auto"` as the most natural voice this server has: a cloud voice with a key, else its own voices, else flite. */
  resolveVoice(spec: VideoSpec): VideoSpec {
    if (spec.voice.provider !== AUTO_VOICE) return spec;
    const keys = this.deps.tts ?? {};
    const provider = !this.deps.media ? "flite" : keys.elevenlabs ? "elevenlabs" : keys.openai ? "openai" : this.deps.local ? SERVER_VOICE_PROVIDER : "flite";
    return { ...spec, voice: { ...spec.voice, provider } };
  }

  /** What else decides how a voice sounds here (the provider's model and default voice), for the asset key. */
  private voiceSalt(spec: VideoSpec): string {
    const { provider, voiceId } = spec.voice;
    const keys = this.deps.tts ?? {};
    if (provider === "elevenlabs") return `${keys.elevenlabs?.modelId ?? ""}|${voiceId ? "" : (keys.elevenlabs?.voiceId ?? "")}`;
    if (provider === "openai") return `${keys.openai?.model ?? ""}|${voiceId ? "" : (keys.openai?.voice ?? "")}|${keys.openai?.instructions ?? ""}`;
    if (provider === SERVER_VOICE_PROVIDER) return voiceId ? "" : (this.deps.local?.voice ?? "");
    return "";
  }

  /** The voices a spec can use on this server, in words, for errors an agent acts on. */
  voiceOptions(): string {
    const options = ['"auto" (the best one here)', '"silent" (captions only)'];
    if (this.deps.local) {
      const list = VOICES.map((v) => `${v.id} (${v.label}, ${v.description.replace(/ · .*$/, "")})`).join(", ");
      options.push(`"${SERVER_VOICE_PROVIDER}" with voiceId one of ${list} (default ${this.deps.local.voice})`);
    }
    const keys = this.deps.tts ?? {};
    if (keys.elevenlabs) options.push('"elevenlabs"');
    if (keys.openai) options.push('"openai" (voiceId e.g. alloy, fable, nova, onyx, shimmer)');
    return options.join("; ");
  }

  /** Why the spec's voice can't be used here, or null when it can. */
  voiceProblem(spec: VideoSpec): string | null {
    const { provider, voiceId } = spec.voice;
    if (LOCAL_PROVIDERS.has(provider)) return null;
    if (provider === SERVER_VOICE_PROVIDER) {
      if (!this.deps.local) return `The server's own voices are turned off (VOICE_LOCAL=off). Use one of: ${this.voiceOptions()}`;
      if (voiceId && !findVoice(voiceId)) return `There is no server voice "${voiceId}". Use one of: ${this.voiceOptions()}`;
    } else if (!cloudProvider(provider, this.deps.tts ?? {}, this.deps.fetch)) {
      return `Voice provider "${provider}" is not configured on the server (no API key set). Use one of: ${this.voiceOptions()}`;
    }
    if (!this.deps.media) return `Voice provider "${provider}" needs a media store to hand the audio to the worker; use "silent" until one is set up`;
    return null;
  }

  /** Synthesises the narration the plan says is missing and adds it to the project's pool. */
  private async voice(projectId: string, revision: number, spec: VideoSpec, plan: RevisionPlan): Promise<void> {
    if (!plan.voice.make.length) return;
    const media = this.deps.media!; // voiceProblem checked it
    const tts = this.speaker(spec);
    const made: Record<string, VideoAsset> = {};
    for (const id of plan.voice.make) {
      const scene = spec.scenes.find((s) => s.id === id)!;
      const r = await tts.synthesize(scene.narration!, { voiceId: spec.voice.voiceId, speed: spec.voice.speed });
      const format = speechExt(r.mime);
      const url = await media.put(`${spec.id}-${projectId}/r${revision}/voice-${scene.id}.${format}`, r.audio, r.mime, tags(spec, projectId));
      made[plan.assets[id]!.voice!] = { kind: "voice", url, sceneId: id, revision, createdAt: this.now().toISOString(), format, durationSec: r.durationSec, words: r.words ?? estimateWordTimings(scene.narration!, r.durationSec) };
    }
    await this.projects.addAssets(projectId, made);
  }

  /** Each narrated scene's stored audio, as the render job takes it. */
  private voiceEntries(spec: VideoSpec, plan: Pick<RevisionPlan, "assets">, pool: Record<string, VideoAsset>): Record<string, VoiceEntry> {
    const out: Record<string, VoiceEntry> = {};
    for (const scene of spec.scenes) {
      const asset = pool[plan.assets[scene.id]?.voice ?? ""];
      if (scene.narration && asset?.kind === "voice" && asset.format && asset.durationSec) out[scene.id] = { url: asset.url, format: asset.format, durationSec: asset.durationSec, words: asset.words ?? [] };
    }
    return out;
  }

  /** What voices a spec: a cloud provider, or the server's own voice (downloaded first if needed). */
  private speaker(spec: VideoSpec): { synthesize(text: string, o: { voiceId?: string; speed?: number }): Promise<{ audio: Uint8Array; mime: string; durationSec: number; words?: { word: string; start: number; end: number }[] }> } {
    const local = this.deps.local;
    if (spec.voice.provider !== SERVER_VOICE_PROVIDER || !local) return cloudProvider(spec.voice.provider, this.deps.tts ?? {}, this.deps.fetch)!;
    const voice = findVoice(spec.voice.voiceId)?.id ?? local.voice;
    const tts = new LocalTextToSpeech(local as LocalSpeech);
    let installed: Promise<void> | null = null;
    return {
      async synthesize(text, o) {
        // The exact voice asked for, never a stand-in: wait for its download the first time.
        installed ??= local.installVoice(voice);
        await installed;
        const r = await tts.synthesize(text, { voice, speed: o.speed, fallback: false });
        return { audio: r.audio, mime: r.mime, durationSec: Math.round(wavDuration(r.audio) * 1000) / 1000 };
      },
    };
  }

  // ---- the chain ----

  /** Moves a production on when one of its jobs finishes. Jobs without production meta are ignored. */
  async onJobSettled(job: Job): Promise<void> {
    if (job.kind !== "video.capture" && job.kind !== "video.render") return;
    const meta = (job.payload.meta as { production?: unknown } | undefined)?.production;
    const parsed = Production.safeParse(meta);
    if (!parsed.success) return;
    const production = parsed.data;
    const spec = VideoSpec.parse(job.payload.spec);
    const revision = await this.projects.revision(production.id, production.revision);
    const exporting = production.stage === "export";

    if (job.status === "failed") {
      const error = (job.result as { error?: string } | null)?.error ?? "unknown error";
      if (revision && !exporting) await this.projects.updateRevision(production.id, production.revision, { status: "failed", error: `${job.kind}: ${error}` });
      await this.deps.notify({ title: `Video ${exporting ? "export " : ""}failed: ${spec.title}`, body: `${job.kind} failed: ${error}` });
      return;
    }
    if (job.status !== "succeeded") return;
    const assetsOf = revision?.assets ?? planRevision({ spec, pool: [] }).assets;
    const request: RevisionRequest = revision?.request ?? { targets: production.targets ?? [], encoder: production.encoder ?? "auto", ...(production.publishAt ? { publishAt: production.publishAt } : {}) };
    const at = this.now().toISOString();

    if (job.kind === "video.capture") {
      const result = VideoCaptureResult.parse(job.result);
      const made: Record<string, VideoAsset> = {};
      for (const [id, clip] of Object.entries(result.clips)) {
        if (!clip.url) {
          await this.projects.updateRevision(production.id, production.revision, { status: "failed", error: `the recording of "${id}" was not uploaded` }).catch(() => {});
          await this.deps.notify({ title: `Video stopped: ${spec.title}`, body: `The recording of "${id}" was not uploaded, so it can't be rendered elsewhere.` });
          return;
        }
        const key = assetsOf[id]?.capture;
        if (key) made[key] = { kind: "capture", url: clip.url, sceneId: id, revision: production.revision, createdAt: at, trimStartSec: clip.trimStartSec, durationSec: clip.durationSec };
      }
      await this.projects.addAssets(production.id, made);
      await this.submitRender(production.id, production.revision, spec, { assets: assetsOf }, request, production.voice as Record<string, VoiceEntry>);
      return;
    }

    const result = VideoRenderResult.parse(job.result);
    // Narration the worker made goes into the pool, so the next revision doesn't make it again.
    const made: Record<string, VideoAsset> = {};
    for (const [id, v] of Object.entries(result.voice ?? {})) {
      const key = assetsOf[id]?.voice;
      if (key) made[key] = { kind: "voice", url: v.url, sceneId: id, revision: production.revision, createdAt: at, format: v.format, durationSec: v.durationSec, words: v.words };
    }
    if (Object.keys(made).length) await this.projects.addAssets(production.id, made).catch((err) => console.error("[video] could not keep narration", err));
    if (exporting) return this.finishExport(production, spec, revision, result, job);

    const outputs = {
      ...(revision?.outputs ?? {}),
      video: { ...(result.url ? { url: result.url } : { path: `${result.outputPath} on worker ${job.nodeId ?? "?"}` }), durationSec: result.durationSec, width: result.width, height: result.height, bytes: result.bytes, encoder: result.encoder },
      ...(result.captionsUrl ? { captionsUrl: result.captionsUrl } : {}),
      ...(result.timeline ? { timeline: result.timeline } : {}),
    };
    if (revision) await this.projects.updateRevision(production.id, production.revision, { status: "ready", outputs });

    const where = result.url ?? `${result.outputPath} on worker ${job.nodeId ?? "?"}`;
    const length = `${Math.round(result.durationSec)}s ${result.width}x${result.height}`;
    const which = revision && production.revision > 1 ? ` (revision ${production.revision}: ${revision.plan})` : "";
    // With a public URL, the notification carries the video so the app plays it in place.
    const media: NotificationMedia[] = result.url
      ? [{ url: result.url, type: "video", alt: spec.title, durationSec: result.durationSec, width: result.width, height: result.height }]
      : [];
    if (!request.targets.length) {
      await this.deps.notify({ title: `Video ready: ${spec.title}`, body: `${length}: ${where}${which}`, media });
      return;
    }
    if (!result.url || !this.deps.hasAction("social.campaign")) {
      const why = !result.url ? "it has no public URL yet (no media store)" : "social.campaign is not available";
      await this.deps.notify({ title: `Video ready: ${spec.title}`, body: `${length}: ${where}. Not proposed for posting because ${why}.${which}`, media });
      return;
    }
    await this.deps.propose(
      {
        vertical: spec.product,
        actionType: "social.campaign",
        summary: `Post video "${spec.title}" (${length}) to ${request.targets.map((t) => t.accountId).join(", ")}`,
        payload: {
          title: spec.title,
          posts: request.targets.map((t) => ({
            accountId: t.accountId,
            content: { text: t.text, ...(t.title ? { title: t.title } : {}), media: [{ url: result.url, type: "video", alt: spec.title }], ...(t.options ? { options: t.options } : {}) },
          })),
          ...(request.publishAt ? { publishAt: request.publishAt } : {}),
          video: { url: result.url, durationSec: result.durationSec, width: result.width, height: result.height, sources: spec.sources, projectId: production.id, revision: production.revision },
        },
      },
      { forceDraft: "a rendered video is always reviewed before it is posted" },
    );
  }

  // ---- export ----

  /** Renders the per-scene clips of a revision; `finishExport` then writes the timeline. */
  async export(raw: Record<string, unknown>) {
    const p = parseExport(raw);
    if (!this.deps.media) throw new Error("video.export needs a media store (PUBLIC_BASE_URL) for the timeline's clips");
    const rev = await this.revisionOf(p.projectId, p.revision);
    const voice = this.voiceEntries(rev.spec, rev, rev.project.pool);
    const job = await this.submitRender(p.projectId, rev.revision, rev.spec, rev, { encoder: rev.request.encoder }, voice, "export", p.format);
    return { projectId: p.projectId, revision: rev.revision, format: p.format, renderJobId: job.id };
  }

  private async finishExport(production: Production, spec: VideoSpec, revision: VideoRevision | null, result: VideoRenderResult, job: Job): Promise<void> {
    const media = this.deps.media;
    const format = production.exportFormat ?? "fcpxml";
    const missing = spec.scenes.filter((s) => !result.stems?.[s.id]).map((s) => s.id);
    if (!media || !result.timeline || missing.length) {
      await this.deps.notify({ title: `Video export failed: ${spec.title}`, body: missing.length ? `The worker sent no clip for ${missing.join(", ")}.` : "The worker sent no timeline (it needs updating)." });
      return;
    }
    const project = await this.projects.get(production.id);
    const pool = project?.pool ?? {};
    const keys = revision?.assets ?? planRevision({ spec, pool: [] }).assets;
    const ext = (url: string, fallback: string) => /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? fallback;
    const files: { name: string; url: string }[] = [];
    const scenes: Record<string, string> = {};
    const voices: Record<string, { file: string; durationSec: number }> = {};
    spec.scenes.forEach((scene, i) => {
      const name = `${String(i + 1).padStart(2, "0")}-${scene.id}.mp4`;
      scenes[scene.id] = name;
      files.push({ name, url: result.stems![scene.id]!.url });
      const voice = result.voice?.[scene.id] ?? (production.voice as Record<string, VoiceEntry>)[scene.id] ?? pool[keys[scene.id]?.voice ?? ""];
      if (scene.narration && voice?.url && voice.durationSec) {
        const file = `voice-${scene.id}.${"format" in voice && voice.format ? voice.format : ext(voice.url, "wav")}`;
        voices[scene.id] = { file, durationSec: voice.durationSec };
        files.push({ name: file, url: voice.url });
      }
    });
    const music = spec.music ? `music.${ext(spec.music.url, "mp3")}` : undefined;
    if (spec.music && music) files.push({ name: music, url: spec.music.url });
    const captionsUrl = result.captionsUrl ?? revision?.outputs.captionsUrl;
    const timeline = { fps: spec.fps, total: result.timeline.total, scenes: result.timeline.scenes.map((s, i) => ({ ...s, kind: spec.scenes[i]!.kind })), words: [] };
    const label = `${spec.title} r${production.revision}`;
    const document = toFcpxml(buildEditTimeline({ ...spec, title: label }, FRAME[spec.format], timeline, { scenes, voices, ...(music ? { music } : {}), ...(captionsUrl ? { srt: "captions.srt" } : {}) }));
    const url = await media.put(`${spec.id}-${production.id}/r${production.revision}/edit/${spec.id}-r${production.revision}.fcpxml`, new TextEncoder().encode(document), "application/xml", tags(spec, production.id));
    const entry: VideoExport = { format, at: this.now().toISOString(), url, files, ...(captionsUrl ? { captionsUrl } : {}) };

    if (format === "resolve-draft") {
      // DaVinci Resolve on Dave's PC downloads the clips and opens the document as a draft timeline.
      const name = (s: string) => s.replace(/[^\w .,'&()+-]+/g, " ").replace(/\s+/g, " ").replace(/^[^\w]+/, "").trim().slice(0, 90) || "Video";
      const draft = DavinciRenderPayload.safeParse({
        clips: files,
        mode: "draft",
        project: name(spec.title),
        timeline: name(`${spec.title} r${production.revision} ${entry.at.slice(11, 19).replace(/:/g, "")}`),
        preset: "YouTube - 1080p",
        outputName: name(spec.id).replace(/[^\w -]+/g, "-"),
        fps: String(spec.fps),
        upload: false,
        timelineFile: { url, name: `${spec.id}-r${production.revision}.fcpxml` },
        extras: captionsUrl ? [{ url: captionsUrl, name: "captions.srt" }] : [],
      });
      if (!draft.success) {
        await this.deps.notify({ title: `Video export failed: ${spec.title}`, body: `The Resolve draft could not be described: ${z.prettifyError(draft.error)}` });
        return;
      }
      const resolveJob = await this.deps.submit({ kind: "davinci.render", requires: ["davinci"], payload: { ...draft.data, meta: { davinci: { title: label, clips: files.length } } } });
      entry.davinciJobId = resolveJob.id;
    }
    if (revision) await this.projects.updateRevision(production.id, production.revision, { outputs: { ...revision.outputs, exports: [...(revision.outputs.exports ?? []), entry] } });
    const tracks = `${spec.scenes.length} scene clips, ${Object.keys(voices).length} narration clips${music ? ", music" : ""}${captionsUrl ? ", captions.srt" : ""}`;
    await this.deps.notify({
      title: `Editable timeline ready: ${label}`,
      body:
        format === "resolve-draft"
          ? `${tracks}. DaVinci Resolve is opening it as a draft on your PC; you'll get a second notification when it is there. Timeline file: ${url}`
          : `${tracks}. Timeline (FCPXML 1.9): ${url}. It refers to its media as media/<name>: download the ${files.length} files listed on the project (get_video_project) into a "media" folder beside it, or export as "resolve-draft" to have the PC do that. Made on worker ${job.nodeId ?? "?"}.`,
    });
  }

  // ---- reading and housekeeping ----

  private async projectOf(id: string): Promise<VideoProject> {
    const project = await this.projects.get(id);
    if (!project) throw new Error(`There is no video project ${id} (list_video_projects shows them)`);
    return project;
  }

  /** A revision of an active project (default the latest), with the project. */
  private async revisionOf(id: string, revision?: number): Promise<VideoRevision & { project: VideoProject }> {
    const project = await this.projectOf(id);
    if (project.status === "archived") throw new Error(`Video project "${project.title}" is archived: its recordings and narration are gone. Produce it again with video.produce (its spec is still in get_video_project).`);
    const r = await this.projects.revision(id, revision ?? project.current);
    if (!r) throw new Error(`Video project "${project.title}" has no revision ${revision ?? project.current} (it has 1 to ${project.current})`);
    return { ...r, project };
  }

  /** Deletes a project's stored assets and export clips and marks it archived. The spec and history stay. */
  async archive(id: string): Promise<{ projectId: string; title: string; deleted: number }> {
    const project = await this.projectOf(id);
    if (project.status === "archived") return { projectId: id, title: project.title, deleted: 0 };
    const revisions = await this.projects.revisions(id);
    const pool = await this.projects.archive(id, this.now());
    const urls = new Set([...Object.values(pool).map((a) => a.url), ...revisions.flatMap((r) => (r.outputs.exports ?? []).flatMap((e) => [e.url, ...e.files.map((f) => f.url)]))]);
    // Music and images are the spec's own URLs, not ours to delete: only files under this project's folder.
    let deleted = 0;
    for (const url of urls) {
      if (!this.deps.media?.remove) break;
      if (await this.deps.media.remove(url).catch(() => false)) deleted++;
    }
    return { projectId: id, title: project.title, deleted };
  }

  /** Archives projects nothing has touched for `days` (0: never). The nightly storage job calls it. */
  async archiveStale(days: number): Promise<string[]> {
    if (days <= 0) return [];
    const cutoff = this.now().getTime() - days * 86_400_000;
    const stale = (await this.projects.list({ limit: 500 })).filter((p) => new Date(p.updatedAt).getTime() < cutoff);
    for (const p of stale) await this.archive(p.id);
    return stale.map((p) => p.title);
  }

  /**
   * Every file an active project still needs (assets, the latest render, exports), as their
   * URLs: the storage clean-up keeps these however old they are.
   */
  async keptFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const p of await this.projects.list({ limit: 500 })) {
      out.push(...Object.values(p.pool).map((a) => a.url));
      const latest = await this.projects.revision(p.id, p.current);
      if (latest?.outputs.video?.url) out.push(latest.outputs.video.url);
      if (latest?.outputs.captionsUrl) out.push(latest.outputs.captionsUrl);
      for (const e of latest?.outputs.exports ?? []) out.push(e.url, ...e.files.map((f) => f.url));
    }
    return out;
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
