import type { VideoSpec } from "./spec";
import type { Timeline } from "./timeline";

/**
 * A video as an editable timeline for an NLE (DaVinci Resolve, Final Cut, Premiere via
 * FCPXML) instead of one flattened MP4: each scene is its own clip on the video track (title
 * and end cards included), each scene's narration is its own clip on an audio track attached
 * to that scene (so it moves with it), the music is one clip on another track, and the captions
 * travel as an SRT beside it. FCPXML 1.9 because Resolve, Final Cut and Premiere all import it
 * and it keeps tracks, offsets and volume; an EDL keeps one track and no levels.
 *
 * Pure: the same spec, timeline and file names always give the same document.
 */

export interface EditScene {
  id: string;
  kind: string;
  /** The scene's picture as its own clip (a file name, no folders). */
  file: string;
  startSec: number;
  durationSec: number;
  /** What is said, as a marker on the clip. */
  note?: string;
  narration?: { file: string; offsetSec: number; durationSec: number };
}

export interface EditTimeline {
  name: string;
  width: number;
  height: number;
  fps: number;
  totalSec: number;
  scenes: EditScene[];
  music?: { file: string; volumeDb: number };
  /** Captions file delivered beside the timeline (imported as a subtitle track by hand). */
  srt?: string;
}

export interface EditFiles {
  /** The per-scene picture clip, by scene id. */
  scenes: Record<string, string>;
  /** Narration audio by scene id, with its length. */
  voices: Record<string, { file: string; durationSec: number } | undefined>;
  music?: string;
  srt?: string;
}

const SAFE_FILE = /^[\w][\w.-]{0,199}$/;

export class EditError extends Error {}

/** The edit model for a rendered spec: where every clip sits, from the same timeline the render used. */
export function buildEditTimeline(spec: Pick<VideoSpec, "title" | "fps" | "scenes" | "music">, frame: { width: number; height: number }, timeline: Timeline, files: EditFiles): EditTimeline {
  if (timeline.scenes.length !== spec.scenes.length) throw new EditError("timeline does not match the spec's scenes");
  const check = (file: string, what: string) => {
    if (!SAFE_FILE.test(file) || file.includes("..")) throw new EditError(`${what} must be a plain file name: ${file}`);
    return file;
  };
  const scenes = spec.scenes.map((scene, i): EditScene => {
    const slot = timeline.scenes[i]!;
    const file = files.scenes[scene.id];
    if (!file) throw new EditError(`no clip for scene "${scene.id}"`);
    const voice = files.voices[scene.id];
    return {
      id: scene.id,
      kind: scene.kind,
      file: check(file, `clip for "${scene.id}"`),
      startSec: slot.start,
      durationSec: slot.duration,
      ...(scene.narration ? { note: scene.narration } : {}),
      ...(voice && slot.voiceStart !== null ? { narration: { file: check(voice.file, `narration for "${scene.id}"`), offsetSec: Math.round(Math.max(0, slot.voiceStart - slot.start) * 1000) / 1000, durationSec: voice.durationSec } } : {}),
    };
  });
  return {
    name: spec.title,
    ...frame,
    fps: spec.fps,
    totalSec: timeline.total,
    scenes,
    ...(spec.music && files.music ? { music: { file: check(files.music, "music"), volumeDb: spec.music.volumeDb } } : {}),
    ...(files.srt ? { srt: check(files.srt, "captions") } : {}),
  };
}

/** Every media file the timeline refers to, once each. */
export function editFiles(edit: EditTimeline): string[] {
  return [...new Set([...edit.scenes.flatMap((s) => [s.file, ...(s.narration ? [s.narration.file] : [])]), ...(edit.music ? [edit.music.file] : [])])];
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, " ");

export interface FcpxmlOptions {
  /** Put before each file name in `src` (default "media/": files in a folder beside the document). */
  mediaPrefix?: string;
}

/**
 * The timeline as FCPXML 1.9. Video clips sit on the spine in order; each scene's narration is
 * connected to its clip one lane below (role dialogue), the music two lanes below (role music)
 * from the first clip across the whole video, at the spec's level. Picture times are whole
 * frames; audio lengths are in samples.
 */
export function toFcpxml(edit: EditTimeline, options: FcpxmlOptions = {}): string {
  const prefix = options.mediaPrefix ?? "media/";
  const fps = edit.fps;
  const frames = (seconds: number) => Math.round(seconds * fps);
  const t = (seconds: number) => (frames(seconds) === 0 ? "0s" : `${frames(seconds)}/${fps}s`);
  const audioT = (seconds: number) => `${Math.max(1, Math.round(seconds * 48000))}/48000s`;
  const total = edit.scenes.reduce((n, s) => n + frames(s.durationSec), 0);
  const totalT = `${total}/${fps}s`;

  const resources: string[] = [`    <format id="r1" name="FFVideoFormat${edit.height}p${fps}" frameDuration="1/${fps}s" width="${edit.width}" height="${edit.height}" colorSpace="1-1-1 (Rec. 709)"/>`];
  let next = 2;
  const ids = new Map<string, string>();
  const asset = (file: string, duration: string, kind: "video" | "audio") => {
    const known = ids.get(file);
    if (known) return known;
    const id = `r${next++}`;
    ids.set(file, id);
    const attrs = kind === "video" ? `hasVideo="1" format="r1" videoSources="1"` : `hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"`;
    resources.push(`    <asset id="${id}" name="${xml(file.replace(/\.[^.]+$/, ""))}" start="0s" duration="${duration}" ${attrs}>`, `      <media-rep kind="original-media" src="${xml(prefix + file)}"/>`, `    </asset>`);
    return id;
  };

  const spine: string[] = [];
  let offset = 0;
  edit.scenes.forEach((scene, i) => {
    const length = frames(scene.durationSec);
    const duration = `${length}/${fps}s`;
    const ref = asset(scene.file, duration, "video");
    spine.push(`          <asset-clip ref="${ref}" name="${xml(`${String(i + 1).padStart(2, "0")} ${scene.id}`)}" offset="${offset === 0 ? "0s" : `${offset}/${fps}s`}" start="0s" duration="${duration}" tcFormat="NDF">`);
    if (scene.narration) {
      const voice = asset(scene.narration.file, audioT(scene.narration.durationSec), "audio");
      spine.push(`            <asset-clip ref="${voice}" lane="-1" name="${xml(`voice ${scene.id}`)}" offset="${t(scene.narration.offsetSec)}" start="0s" duration="${audioT(scene.narration.durationSec)}" audioRole="dialogue"/>`);
    }
    if (i === 0 && edit.music) {
      const music = asset(edit.music.file, totalT, "audio");
      spine.push(
        `            <asset-clip ref="${music}" lane="-2" name="music" offset="0s" start="0s" duration="${totalT}" audioRole="music">`,
        `              <adjust-volume amount="${edit.music.volumeDb}dB"/>`,
        `            </asset-clip>`,
      );
    }
    if (scene.note) spine.push(`            <marker start="0s" duration="1/${fps}s" value="${xml(scene.note.slice(0, 300))}"/>`);
    spine.push(`          </asset-clip>`);
    offset += length;
  });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.9">`,
    `  <resources>`,
    ...resources,
    `  </resources>`,
    `  <library>`,
    `    <event name="${xml(edit.name)}">`,
    `      <project name="${xml(edit.name)}">`,
    `        <sequence format="r1" duration="${totalT}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    `          <spine>`,
    ...spine.map((l) => `  ${l}`),
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
    ``,
  ].join("\n");
}

/**
 * Points every media file of an FCPXML document somewhere else: `resolve` gets the file name
 * (whatever folder prefix the document used) and returns the new `src`, e.g. a file:// URL on
 * the PC the files were downloaded to. A file it returns nothing for keeps its `src`.
 */
export function relinkFcpxml(document: string, resolve: (file: string) => string | undefined): string {
  return document.replace(/(<media-rep\b[^>]*\bsrc=")([^"]*)(")/g, (whole, head: string, src: string, tail: string) => {
    const file = src.replace(/&amp;/g, "&").split(/[\\/]/).pop() ?? "";
    const to = resolve(file);
    return to ? `${head}${xml(to)}${tail}` : whole;
  });
}

/** A local path as a file:// URL an NLE accepts (Windows drive paths included). */
export function fileUrl(path: string): string {
  const normal = path.replace(/\\/g, "/");
  return `file://${normal.startsWith("/") ? "" : "/"}${normal.split("/").map((part) => (/^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join("/")}`;
}
