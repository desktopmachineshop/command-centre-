import { createHash } from "node:crypto";
import { z } from "zod";
import { CAPTURE_VIEWPORT, type CaptureScene, type Scene, VideoSpec } from "./spec";

/**
 * Video projects: a production kept as its VideoSpec (the editable source of truth) plus the
 * assets made from it, so a later change re-uses everything whose inputs didn't change.
 *
 * Every expensive asset has a key: a hash of exactly the inputs that produce it.
 * - narration (voice): the scene's text and the voice (provider, voice id, speed);
 * - a screen recording (capture): the steps, the viewport, the cursor, the signed-in profile
 *   and, when a step highlights something, the accent colour it is drawn in.
 * Assets live in a pool keyed by that hash, not by scene: moving, renaming or duplicating a
 * scene, or going back to an earlier wording, finds the asset again. Everything else (order,
 * on-screen text, captions, brand, format, music, timing) only changes the composition, which
 * is one ffmpeg run over the stored assets. All of it is pure, so "what needs regenerating" is
 * tested without rendering anything.
 */

/** Canonical JSON: keys sorted, undefined dropped, so equal values always hash the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A short stable key for some inputs. */
export const hashOf = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);

type SpecVoice = Pick<VideoSpec, "voice">;

/**
 * Key of a scene's narration audio, or null when the scene says nothing. `salt` is whatever
 * else decides how the voice sounds on this server (e.g. the provider's model).
 */
export function voiceKey(spec: SpecVoice, scene: Pick<Scene, "narration">, salt = ""): string | null {
  const text = scene.narration?.trim();
  if (!text) return null;
  return hashOf({ asset: "voice", text, provider: spec.voice.provider, voiceId: spec.voice.voiceId ?? null, speed: spec.voice.speed, salt });
}

/** Key of a capture scene's screen recording. */
export function captureKey(spec: Pick<VideoSpec, "format" | "brand">, scene: CaptureScene): string {
  return hashOf({
    asset: "capture",
    steps: scene.steps,
    viewport: scene.viewport ?? CAPTURE_VIEWPORT[spec.format],
    cursor: scene.cursor,
    authProfile: scene.authProfile ?? null,
    accent: scene.steps.some((s) => s.action === "highlight") ? spec.brand.colours.accent.toLowerCase() : null,
  });
}

/** How the output is encoded: part of what makes a render "the same". */
export interface OutputSettings {
  encoder?: string;
  preset?: string;
}

/**
 * Key of the finished composition: everything the picture and sound depend on. The title,
 * the id and the sources are not in it (they aren't drawn), so changing only those renders nothing.
 */
export function composeKey(spec: VideoSpec, assets: Record<string, SceneAssetKeys>, output: OutputSettings = {}): string {
  const { id: _id, title: _title, sources: _sources, type: _type, ...drawn } = spec;
  return hashOf({ asset: "compose", spec: drawn, assets: spec.scenes.map((s) => assets[s.id] ?? {}), output });
}

export interface SceneAssetKeys {
  voice?: string;
  capture?: string;
}

/** The asset keys of every scene of a spec. */
export function assetKeys(spec: VideoSpec, voiceSalt = ""): Record<string, SceneAssetKeys> {
  const out: Record<string, SceneAssetKeys> = {};
  for (const scene of spec.scenes) {
    const voice = voiceKey(spec, scene, voiceSalt);
    out[scene.id] = { ...(voice ? { voice } : {}), ...(scene.kind === "capture" ? { capture: captureKey(spec, scene) } : {}) };
  }
  return out;
}

/** Voices that cost nothing and are identical every time: made on the worker during each render, never stored. */
export const EPHEMERAL_VOICES = new Set(["silent"]);

export interface PlanInput {
  spec: VideoSpec;
  /** Keys of the assets the project already holds. */
  pool: ReadonlySet<string> | readonly string[];
  /** The compose key of the revision this one is based on, if it was rendered. */
  renderedComposeKey?: string | null;
  voiceSalt?: string;
  output?: OutputSettings;
  /** Render even when nothing changed (video.rerender). */
  force?: boolean;
}

export interface RevisionPlan {
  /** Each scene's asset keys in this revision. */
  assets: Record<string, SceneAssetKeys>;
  /** Scene ids, in order. `make` is the only work that costs anything. */
  voice: { reuse: string[]; make: string[]; ephemeral: string[] };
  capture: { reuse: string[]; make: string[] };
  /** Whether the video has to be composed again. False: this spec is already rendered. */
  compose: boolean;
  composeKey: string;
  /** One line for the approval: what is re-used and what is redone. */
  summary: string;
}

/**
 * What a revision needs: which narrations are synthesised, which scenes are re-recorded, and
 * whether anything is rendered at all. A scene whose key is in the pool is re-used; two scenes
 * with the same key are made once.
 */
export function planRevision(input: PlanInput): RevisionPlan {
  const { spec } = input;
  const pool = input.pool instanceof Set ? input.pool : new Set(input.pool);
  const assets = assetKeys(spec, input.voiceSalt);
  const plan: RevisionPlan = { assets, voice: { reuse: [], make: [], ephemeral: [] }, capture: { reuse: [], make: [] }, compose: true, composeKey: composeKey(spec, assets, input.output), summary: "" };
  const making = new Set<string>();
  const sort = (key: string | undefined, id: string, into: { reuse: string[]; make: string[] }) => {
    if (!key) return;
    // A second scene with the same inputs shares the asset the first one makes.
    if (pool.has(key) || making.has(key)) into.reuse.push(id);
    else {
      into.make.push(id);
      making.add(key);
    }
  };
  for (const scene of spec.scenes) {
    const keys = assets[scene.id]!;
    if (keys.voice && EPHEMERAL_VOICES.has(spec.voice.provider)) plan.voice.ephemeral.push(scene.id);
    else sort(keys.voice, scene.id, plan.voice);
    sort(keys.capture, scene.id, plan.capture);
  }
  plan.compose = input.force === true || plan.voice.make.length > 0 || plan.capture.make.length > 0 || input.renderedComposeKey !== plan.composeKey;
  plan.summary = planSummary(plan);
  return plan;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function planSummary(plan: RevisionPlan): string {
  if (!plan.compose) return "Nothing to render: this version is already rendered.";
  const parts: string[] = [];
  const voiced = plan.voice.reuse.length + plan.voice.make.length;
  if (plan.voice.make.length) parts.push(`new voice for ${plan.voice.make.join(", ")}`);
  if (plan.capture.make.length) parts.push(`re-records ${plan.capture.make.join(", ")}`);
  const kept: string[] = [];
  if (plan.voice.reuse.length) kept.push(`${plan.voice.reuse.length} of ${count(voiced, "narration")}`);
  if (plan.capture.reuse.length) kept.push(`${plan.capture.reuse.length} of ${count(plan.capture.reuse.length + plan.capture.make.length, "recording")}`);
  if (!parts.length) return `Re-renders only${kept.length ? `, re-using ${kept.join(" and ")}` : ""}: no new voice or recording.`;
  return `Re-renders with ${parts.join("; ")}${kept.length ? `; re-uses ${kept.join(" and ")}` : ""}.`;
}

// ---- Patches: how a revision edits the spec ----

const SceneId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const Place = { after: SceneId.optional(), before: SceneId.optional(), at: z.enum(["start", "end"]).optional() };
const Fields = z.record(z.string(), z.unknown());

export const SceneOp = z.discriminatedUnion("op", [
  /** Change fields of a scene; null removes an optional field. Its id and kind stay. */
  z.object({ op: z.literal("update"), id: SceneId, set: Fields }),
  z.object({ op: z.literal("remove"), id: SceneId }),
  /** Add a scene (a whole scene object), by default at the end. */
  z.object({ op: z.literal("add"), scene: Fields, ...Place }),
  z.object({ op: z.literal("move"), id: SceneId, ...Place }),
]);
export type SceneOp = z.infer<typeof SceneOp>;

/**
 * An edit to a VideoSpec. `set` merges into the top level (brand, voice, captions and music
 * merge one level deep; null removes music); `scenes` are applied in order; `order` then puts
 * the scenes in the given order (every id exactly once).
 */
export const SpecPatch = z
  .object({
    set: Fields.optional(),
    scenes: z.array(SceneOp).max(100).optional(),
    order: z.array(SceneId).max(40).optional(),
  })
  .strict();
export type SpecPatch = z.infer<typeof SpecPatch>;
export type SpecPatchInput = z.input<typeof SpecPatch>;

export class PatchError extends Error {}

const MERGED = new Set(["brand", "voice", "captions", "music", "transition"]);
const FIXED = new Set(["id", "product", "version", "scenes"]);

const merge = (base: unknown, set: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = base && typeof base === "object" ? { ...(base as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) out[k] = merge(out[k], v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
};

/**
 * Applies a patch and returns the new spec, validated. Throws PatchError for an edit that
 * can't be applied (unknown scene, changing an id), and zod's error if the result isn't a
 * valid spec.
 */
export function applyPatch(spec: VideoSpec, rawPatch: SpecPatchInput): VideoSpec {
  const patch = SpecPatch.parse(rawPatch);
  const next: Record<string, unknown> = structuredClone(spec);
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (FIXED.has(key)) throw new PatchError(`"${key}" can't be changed by a patch${key === "scenes" ? ": use the scenes operations" : ""}`);
    if (value === null) delete next[key];
    else if (MERGED.has(key) && value && typeof value === "object" && !Array.isArray(value)) next[key] = merge(next[key], value as Record<string, unknown>);
    else next[key] = value;
  }

  let scenes = (next.scenes as Record<string, unknown>[]).map((s) => ({ ...s }));
  const indexOf = (id: string) => {
    const i = scenes.findIndex((s) => s.id === id);
    if (i < 0) throw new PatchError(`There is no scene "${id}" (scenes: ${scenes.map((s) => s.id).join(", ")})`);
    return i;
  };
  const place = (scene: Record<string, unknown>, where: { after?: string; before?: string; at?: "start" | "end" }) => {
    if ([where.after, where.before, where.at].filter((x) => x !== undefined).length > 1) throw new PatchError("Give one of after, before or at");
    if (where.after) scenes.splice(indexOf(where.after) + 1, 0, scene);
    else if (where.before) scenes.splice(indexOf(where.before), 0, scene);
    else if (where.at === "start") scenes.unshift(scene);
    else scenes.push(scene);
  };
  for (const op of patch.scenes ?? []) {
    if (op.op === "update") {
      const i = indexOf(op.id);
      for (const key of ["id", "kind"]) {
        if (key in op.set && op.set[key] !== scenes[i]![key]) throw new PatchError(`A scene's ${key} can't be changed: remove "${op.id}" and add the new scene`);
      }
      scenes[i] = merge(scenes[i], op.set);
    } else if (op.op === "remove") {
      scenes.splice(indexOf(op.id), 1);
    } else if (op.op === "add") {
      if (scenes.some((s) => s.id === op.scene.id)) throw new PatchError(`There is already a scene "${String(op.scene.id)}"`);
      place({ ...op.scene }, op);
    } else {
      const [scene] = scenes.splice(indexOf(op.id), 1);
      place(scene!, op);
    }
  }
  if (patch.order) {
    const ids = scenes.map((s) => String(s.id));
    if (patch.order.length !== ids.length || new Set(patch.order).size !== ids.length || patch.order.some((id) => !ids.includes(id))) {
      throw new PatchError(`order must list every scene exactly once (scenes: ${ids.join(", ")})`);
    }
    scenes = patch.order.map((id) => scenes[ids.indexOf(id)]!);
  }
  next.scenes = scenes;
  return VideoSpec.parse(next);
}

/**
 * Keeps the existing screen recordings when the format changes: a capture scene without its
 * own viewport is recorded at the format's default, so a new format would mean a new
 * recording. This writes the old viewport into those scenes, and the recording is fitted into
 * the new frame instead.
 */
export function pinCaptureViewports(base: VideoSpec, next: VideoSpec): VideoSpec {
  if (base.format === next.format) return next;
  const before = new Map(base.scenes.map((s) => [s.id, s]));
  return {
    ...next,
    scenes: next.scenes.map((s) => {
      const old = before.get(s.id);
      return s.kind === "capture" && old?.kind === "capture" && !s.viewport ? { ...s, viewport: old.viewport ?? CAPTURE_VIEWPORT[base.format] } : s;
    }),
  };
}

/** What changed between two specs, in a few words per scene, for the revision history. */
export function describeChanges(base: VideoSpec, next: VideoSpec): string[] {
  const out: string[] = [];
  const top = ["title", "format", "fps", "type", "brand", "voice", "captions", "music", "transition"] as const;
  for (const key of top) {
    const a = (base as Record<string, unknown>)[key];
    const b = (next as Record<string, unknown>)[key];
    if (canonical(a) !== canonical(b)) out.push(key === "format" || key === "title" ? `${key}: ${String(a)} → ${String(b)}` : `${key} changed`);
  }
  const before = new Map(base.scenes.map((s) => [s.id, s]));
  const after = new Map(next.scenes.map((s) => [s.id, s]));
  for (const s of base.scenes) if (!after.has(s.id)) out.push(`removed scene ${s.id}`);
  for (const s of next.scenes) {
    const old = before.get(s.id);
    if (!old) {
      out.push(`added ${s.kind} scene ${s.id}`);
      continue;
    }
    const fields = [...new Set([...Object.keys(old), ...Object.keys(s)])].filter((k) => canonical((old as Record<string, unknown>)[k]) !== canonical((s as Record<string, unknown>)[k]));
    if (fields.length) out.push(`${s.id}: ${fields.join(", ")}`);
  }
  const kept = (spec: VideoSpec, other: Map<string, Scene>) => spec.scenes.filter((s) => other.has(s.id)).map((s) => s.id).join(",");
  if (kept(base, after) !== kept(next, before)) out.push("scene order");
  return out;
}
