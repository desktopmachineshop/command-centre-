import type { BlobInfo } from "@cc/storage";
import {
  type Capability,
  DAVINCI_FPS,
  DavinciMode,
  DavinciOutputName,
  DavinciProjectName,
  DavinciRenderPayload,
  DavinciRenderResult,
  type Job,
  type NotificationMedia,
} from "@cc/core";
import { z } from "zod";
import type { ActionExecutor } from "./actions";
import { MEDIA_FILE } from "./http/social";

/**
 * `davinci.render`: DaVinci Resolve on a desktop worker puts clips end to end on a timeline,
 * renders it with a preset and uploads the file (see apps/worker/src/handlers/davinci.ts).
 *
 * Two ways in, both through `start`:
 *  - the `davinci.render` action, which agents propose and Dave approves like any other;
 *  - `POST /api/davinci/render`, for Dave's own requests.
 *
 * Clips are files already in Command Centre storage (by id, served at /media/<id>) or http(s)
 * URLs. When the job settles, Dave gets a notification with the render (or the error).
 */

/** Resolve's default "YouTube - 1080p" preset, the first one workers allow out of the box. */
export const DEFAULT_DAVINCI_PRESET = "YouTube - 1080p";

const StorageId = z.string().regex(/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/, "a storage file id like 3f2a….mp4");

export const DavinciRenderRequest = z.object({
  /** In timeline order: storage files (`{fileId}`) or downloads (`{url, name?}`). Empty re-renders an existing project. */
  clips: z
    .array(
      z.union([
        z.object({ fileId: StorageId }).strict(),
        z.object({ url: z.url({ protocol: /^https?$/ }), name: z.string().max(200).optional() }).strict(),
      ]),
    )
    .max(100)
    .default([]),
  /** `draft` builds the project and timeline in Resolve and stops there, for Dave to edit and render. */
  mode: DavinciMode.default("render"),
  /** A Resolve project: opened and added to if it exists, created otherwise. Needed to keep a project. */
  project: DavinciProjectName.optional(),
  /** The timeline in that project the clips are added to (default "Main"). */
  timeline: DavinciProjectName.optional(),
  /** Keep the project open in Resolve afterwards (drafts and existing projects always are). */
  keepProject: z.boolean().default(false),
  preset: z.string().min(1).max(100).default(DEFAULT_DAVINCI_PRESET),
  /** Defaults to the project name, or "resolve-render". */
  outputName: DavinciOutputName.optional(),
  fps: z.enum(DAVINCI_FPS).optional(),
  /** Shown in the notification; defaults to the project or output name. */
  title: z.string().min(1).max(200).optional(),
});
export type DavinciRenderRequest = z.infer<typeof DavinciRenderRequest>;

/** Carried in the job's payload so the notification can name the render. */
const Meta = z.object({ title: z.string(), clips: z.number().default(0) });

export interface DavinciDeps {
  submit(job: { kind: string; requires: Capability[]; payload: Record<string, unknown> }): Promise<Job>;
  notify(n: { title: string; body: string; media?: NotificationMedia[] }): Promise<void>;
  /** Looks up a storage file, for `{fileId}` clips. */
  head?(id: string): Promise<BlobInfo | null>;
  /** PUBLIC_BASE_URL: workers download storage clips from <base>/media/<id>. */
  publicBaseUrl?: string;
}

/** A request the caller can fix (bad clip, missing file); the API answers 400. */
export class DavinciRequestError extends Error {}

/** A plain, unique clip file name: `01-<name>`, keeping a safe extension. */
export function clipName(index: number, raw: string | undefined, fallbackExt: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  let name = base.replace(/[^\w. -]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[^\w]+/, "").slice(0, 180);
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = `${name || "clip"}.${fallbackExt}`;
  return `${String(index + 1).padStart(2, "0")}-${name}`;
}

function extOf(url: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
  return m?.[1]?.toLowerCase() ?? "mp4";
}

/** An output file name from a project name (output names are stricter). */
export function outputNameFor(project: string): string {
  return project.replace(/[^\w -]+/g, "-").replace(/^[^\w]+/, "").slice(0, 100) || "resolve-render";
}

export class DavinciRenders {
  constructor(private readonly deps: DavinciDeps) {}

  executors(): Record<string, ActionExecutor> {
    return {
      "davinci.render": {
        description:
          "Edit and render in DaVinci Resolve on Dave's PC: clips go end to end on a timeline, which is rendered with a Resolve preset and uploaded to storage. " +
          "Name a project to work in it: an existing one is opened and the clips are added to the end of its timeline; otherwise it is created. " +
          'mode "draft" builds the timeline without rendering, for Dave to finish by hand; keepProject keeps a rendered project. ' +
          `payload: { clips: [{ fileId } | { url, name? }] (in order; may be empty to re-render an existing project), mode? ("render"|"draft"), project?, timeline? (default "Main"), keepProject?, preset? (default "${DEFAULT_DAVINCI_PRESET}"), outputName?, fps?, title? }`,
        validate: async (payload) => {
          await this.build(payload);
        },
        execute: (payload) => this.start(payload),
      },
    };
  }

  /** Validates a request, resolves its clips and submits the job. */
  async start(raw: unknown): Promise<{ jobId: string; clips: number; mode: string; project: string | null; preset: string }> {
    const payload = await this.build(raw);
    const job = await this.deps.submit({ kind: "davinci.render", requires: ["davinci"], payload });
    return {
      jobId: job.id,
      clips: (payload.clips as unknown[]).length,
      mode: payload.mode as string,
      project: (payload.project as string | undefined) ?? null,
      preset: payload.preset as string,
    };
  }

  /** The job payload for a request, checked against the worker's own schema. */
  private async build(raw: unknown): Promise<Record<string, unknown>> {
    const parsed = DavinciRenderRequest.safeParse(raw);
    if (!parsed.success) throw new DavinciRequestError(`Invalid davinci.render request:\n${z.prettifyError(parsed.error)}`);
    const request = parsed.data;
    const clips: { url: string; name: string }[] = [];
    for (const [i, clip] of request.clips.entries()) {
      if ("url" in clip) {
        clips.push({ url: clip.url, name: clipName(i, clip.name ?? decodeURIComponent(new URL(clip.url).pathname), extOf(clip.url)) });
        continue;
      }
      clips.push(await this.storageClip(i, clip.fileId));
    }
    const outputName = request.outputName ?? (request.project ? outputNameFor(request.project) : "resolve-render");
    const checked = DavinciRenderPayload.safeParse({
      clips,
      mode: request.mode,
      ...(request.project ? { project: request.project } : {}),
      ...(request.timeline ? { timeline: request.timeline } : {}),
      keepProject: request.keepProject,
      preset: request.preset,
      outputName,
      ...(request.fps ? { fps: request.fps } : {}),
      upload: true,
      uploadFolder: "renders",
    });
    if (!checked.success) throw new DavinciRequestError(`Invalid davinci.render request:\n${z.prettifyError(checked.error)}`);
    const title = request.title ?? request.project ?? outputName;
    return { ...checked.data, meta: { davinci: { title, clips: clips.length } } };
  }

  private async storageClip(index: number, id: string): Promise<{ url: string; name: string }> {
    const { head, publicBaseUrl } = this.deps;
    if (!head || !publicBaseUrl) throw new DavinciRequestError("Storage clips need PUBLIC_BASE_URL, so the PC can download them; pass clip URLs instead");
    const info = await head(id);
    if (!info) throw new DavinciRequestError(`There is no storage file ${id}`);
    if (!info.contentType.startsWith("video/") || !MEDIA_FILE.test(id)) {
      throw new DavinciRequestError(`Storage file ${id} (${info.name}) is ${info.contentType}, not an mp4, mov or webm video`);
    }
    return { url: `${publicBaseUrl.replace(/\/+$/, "")}/media/${id}`, name: clipName(index, info.name, id.split(".").pop()!) };
  }

  /** Tells Dave when a davinci.render job finishes or fails. Other jobs are ignored. */
  async onJobSettled(job: Job): Promise<void> {
    if (job.kind !== "davinci.render") return;
    const meta = Meta.safeParse((job.payload.meta as { davinci?: unknown } | undefined)?.davinci);
    const title = meta.success ? meta.data.title : String(job.payload.project ?? job.payload.outputName ?? "render");
    const draft = job.payload.mode === "draft";
    const pc = job.nodeId ?? "the PC";
    if (job.status === "failed") {
      const error = (job.result as { error?: string } | null)?.error ?? "unknown error";
      const project = typeof job.payload.project === "string" ? `\nProject "${job.payload.project}" was left as it was saved.` : "";
      await this.deps.notify({ title: `Resolve ${draft ? "draft" : "render"} failed: ${title}`, body: `${error}${project}` });
      return;
    }
    if (job.status !== "succeeded") return;
    const result = DavinciRenderResult.safeParse(job.result);
    if (!result.success) {
      await this.deps.notify({ title: `Resolve job finished: ${title}`, body: "The PC sent back a result Command Centre couldn't read." });
      return;
    }
    const r = result.data;
    const clips = meta.success ? meta.data.clips : 0;
    const added = clips ? `${clips} clip${clips === 1 ? "" : "s"} ${r.existing ? "added to" : "on"} timeline "${r.timeline ?? "Main"}"` : `timeline "${r.timeline ?? "Main"}"`;
    const open = r.project ? `Project "${r.project}" (${r.existing ? "existing" : "new"}) is open in Resolve on ${pc}, ${added}.` : "";
    if (r.mode === "draft" || r.outputPath === null) {
      await this.deps.notify({ title: `Resolve draft ready: ${title}`, body: `${open} It hasn't been rendered: edit it and render it from Resolve.`.trim() });
      return;
    }
    const size = `${Math.max(1, Math.round(r.bytes / 1024 / 1024))} MB`;
    const where = r.url ?? `${r.outputPath} on worker ${pc}`;
    const media: NotificationMedia[] = r.url && MEDIA_FILE.test(r.url.split("/").pop() ?? "") ? [{ url: r.url, type: "video", alt: title }] : [];
    await this.deps.notify({ title: `Resolve render ready: ${title}`, body: `${size}: ${where}${open ? `. ${open}` : ""}`, media });
  }
}
