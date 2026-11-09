import { FRAME, type VideoSpec } from "./spec";
import type { Timeline } from "./timeline";

/**
 * The compositor: turns a spec, its timeline and the local files for each
 * scene into one ffmpeg command (a filter graph, no shell). It is a pure
 * function, so the graph is unit-tested without running ffmpeg.
 *
 * - capture scenes: the screen recording, trimmed to start once the page has
 *   loaded, fitted into the frame, frozen on its last frame if the voice runs longer;
 * - image scenes: the still, with a slow Ken Burns push-in;
 * - title, slide and outro scenes: a brand-coloured background; their text is
 *   drawn by libass from the same ASS file as the captions;
 * - the logo sits in the corner of content scenes and above the heading on cards;
 * - narration clips are placed at their scene's voice start over a silent bed,
 *   music (optional) loops under them and ducks while the voice speaks, and the
 *   mix is normalised to -14 LUFS (the level YouTube, Instagram and TikTok play at).
 */

export interface VisualAsset {
  kind: "video" | "image";
  /** File name inside the render directory. */
  file: string;
  /** Seconds to skip at the start of a recording (the blank page before the first load). */
  trimStartSec?: number;
  /** Use at most this much of a recording (a clip's out-point); the last frame is held after it. */
  maxDurationSec?: number;
}

export type VideoEncoder = "libx264" | "h264_nvenc";

export interface ComposeInput {
  spec: Pick<VideoSpec, "format" | "fps" | "brand" | "scenes" | "music"> & Partial<Pick<VideoSpec, "transition">>;
  timeline: Timeline;
  /** Visual per capture and image scene id. */
  visuals: Record<string, VisualAsset>;
  /** Narration audio file per scene id. */
  narration: Record<string, string>;
  /** ASS file with captions and card text. */
  subtitles?: string;
  /** Folder of extra fonts for libass (brand fonts not installed on the machine). */
  fontsDir?: string;
  logo?: string;
  music?: string;
  encoder: VideoEncoder;
  /** x264 preset (or NVENC p1–p7). */
  preset?: string;
  /** Quality: CRF for x264, CQ for NVENC. */
  quality?: number;
  /** Picture only, with no fade from or to black: a clip for an editor's timeline rather than a finished video. */
  videoOnly?: boolean;
  output: string;
}

export interface ComposePlan {
  args: string[];
  filterGraph: string;
  durationSec: number;
}

/** File names only, so nothing in the graph or the arguments can point outside the render directory. */
const SAFE_FILE = /^[\w][\w.-]{0,199}$/;

export class ComposeError extends Error {}

function file(name: string, what: string): string {
  if (!SAFE_FILE.test(name) || name.includes("..")) throw new ComposeError(`${what} must be a plain file name in the render directory: ${name}`);
  return name;
}

const hex = (colour: string) => `0x${colour.replace("#", "")}`;
const sec = (n: number) => String(Math.round(n * 1000) / 1000);

export function buildComposePlan(input: ComposeInput): ComposePlan {
  const { spec, timeline } = input;
  const { width: W, height: H } = FRAME[spec.format];
  const fps = spec.fps;
  const bg = hex(spec.brand.colours.background);
  const T = timeline.total;
  if (timeline.scenes.length !== spec.scenes.length) throw new ComposeError("timeline does not match the spec's scenes");

  const args: string[] = [];
  const graph: string[] = [];
  let inputIndex = 0;
  const addInput = (...inputArgs: string[]) => {
    args.push(...inputArgs);
    return inputIndex++;
  };

  // --- video, one chain per scene ---
  const sceneLabels: string[] = [];
  spec.scenes.forEach((scene, i) => {
    const slot = timeline.scenes[i]!;
    const D = sec(slot.duration);
    const label = `v${i}`;
    sceneLabels.push(`[${label}]`);
    const fitContain = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg}`;
    const fitCover = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`;
    // Scenes meet through a short dip to the brand background instead of a hard jump; the video's own
    // fade from and to black covers the first scene's start and the last one's end.
    const fadeSec = spec.transition?.style === "cut" ? 0 : Math.min(spec.transition?.durationSec ?? 0.2, slot.duration / 4);
    const dip =
      fadeSec > 0
        ? `${i > 0 ? `,fade=t=in:st=0:d=${sec(fadeSec)}:color=${bg}` : ""}${i < spec.scenes.length - 1 ? `,fade=t=out:st=${sec(slot.duration - fadeSec)}:d=${sec(fadeSec)}:color=${bg}` : ""}`
        : "";
    const tail = `setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${D},trim=duration=${D},setpts=PTS-STARTPTS${dip},format=yuv420p`;

    if (scene.kind === "capture" || scene.kind === "image") {
      const visual = input.visuals[scene.id];
      if (!visual) throw new ComposeError(`no visual for ${scene.kind} scene "${scene.id}"`);
      const name = file(visual.file, `visual for "${scene.id}"`);
      if (visual.kind === "video") {
        const idx = addInput(...(visual.trimStartSec ? ["-ss", sec(visual.trimStartSec)] : []), ...(visual.maxDurationSec ? ["-t", sec(visual.maxDurationSec)] : []), "-i", name);
        const fit = scene.kind === "capture" && scene.fit === "cover" ? fitCover : fitContain;
        graph.push(`[${idx}:v]${fit},${tail}[${label}]`);
      } else {
        const idx = addInput("-loop", "1", "-framerate", String(fps), "-t", D, "-i", name);
        if (scene.kind === "image" && scene.kenBurns) {
          // Upscale first so the slow zoom doesn't judder, then push in by up to 12%.
          graph.push(
            `[${idx}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},` +
              `zoompan=z='min(1+0.0008*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},${tail}[${label}]`,
          );
        } else {
          graph.push(`[${idx}:v]${fitContain},${tail}[${label}]`);
        }
      }
    } else {
      const idx = addInput("-f", "lavfi", "-i", `color=c=${bg}:s=${W}x${H}:r=${fps}:d=${D}`);
      graph.push(`[${idx}:v]${tail}[${label}]`);
    }
  });

  const blackFades = input.videoOnly ? "" : `,fade=t=in:st=0:d=0.3,fade=t=out:st=${sec(Math.max(0, T - 0.4))}:d=0.4`;
  graph.push(`${sceneLabels.join("")}concat=n=${sceneLabels.length}:v=1:a=0${blackFades}[vcat]`);
  let videoOut = "vcat";

  if (input.logo) {
    const idx = addInput("-i", file(input.logo, "logo"));
    const ranges = (kinds: string[]) =>
      timeline.scenes
        .filter((s) => kinds.includes(s.kind))
        .map((s) => `between(t,${sec(s.start)},${sec(s.start + s.duration)})`)
        .join("+");
    const cardRanges = ranges(["title", "outro"]);
    const contentRanges = ranges(["capture", "image", "slide"]);
    const small = Math.round(H * (spec.format === "16:9" ? 0.06 : 0.04));
    const large = Math.round(Math.min(W, H) * 0.16);
    graph.push(`[${idx}:v]format=rgba,split=2[logoS0][logoL0]`, `[logoS0]scale=-1:${small}[logoS]`, `[logoL0]scale=-1:${large}[logoL]`);
    if (contentRanges) {
      graph.push(`[${videoOut}][logoS]overlay=x=W-w-${Math.round(W * 0.03)}:y=${Math.round(H * 0.025)}:enable='${contentRanges}'[vlogo1]`);
      videoOut = "vlogo1";
    } else graph.push(`[logoS]nullsink`);
    if (cardRanges) {
      graph.push(`[${videoOut}][logoL]overlay=x=(W-w)/2:y=${Math.round(H * 0.18)}:enable='${cardRanges}'[vlogo2]`);
      videoOut = "vlogo2";
    } else graph.push(`[logoL]nullsink`);
  }

  if (input.subtitles) {
    const fonts = input.fontsDir ? `:fontsdir=${file(input.fontsDir, "fonts directory")}` : "";
    graph.push(`[${videoOut}]subtitles=filename=${file(input.subtitles, "subtitles")}${fonts}[vout]`);
  } else {
    graph.push(`[${videoOut}]null[vout]`);
  }

  const quality = input.quality ?? (input.encoder === "h264_nvenc" ? 21 : 20);
  const video =
    input.encoder === "h264_nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", input.preset ?? "p5", "-rc", "vbr", "-cq", String(quality), "-b:v", "0"]
      : ["-c:v", "libx264", "-preset", input.preset ?? "medium", "-crf", String(quality)];
  if (input.videoOnly) {
    const filterGraph = graph.join(";\n");
    args.push("-filter_complex", filterGraph, "-map", "[vout]", ...video, "-pix_fmt", "yuv420p", "-r", String(fps), "-an", "-t", sec(T), "-movflags", "+faststart", file(input.output, "output"));
    return { args, filterGraph, durationSec: T };
  }

  // --- audio ---
  const bed = addInput("-f", "lavfi", "-t", sec(T), "-i", "anullsrc=r=48000:cl=stereo");
  const voiceLabels = [`[${bed}:a]`];
  spec.scenes.forEach((scene, i) => {
    const audio = input.narration[scene.id];
    const start = timeline.scenes[i]!.voiceStart;
    if (!audio || start === null) return;
    const idx = addInput("-i", file(audio, `narration for "${scene.id}"`));
    const ms = Math.round(start * 1000);
    graph.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[n${i}]`);
    voiceLabels.push(`[n${i}]`);
  });
  graph.push(`${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=first:dropout_transition=0:normalize=0[voice]`);
  let audioOut = "voice";

  if (input.music && spec.music) {
    const idx = addInput("-stream_loop", "-1", "-i", file(input.music, "music"));
    graph.push(
      `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${sec(T)},volume=${spec.music.volumeDb}dB,` +
        `afade=t=in:d=1,afade=t=out:st=${sec(Math.max(0, T - 2))}:d=2[music]`,
      `[voice]asplit=2[voiceA][voiceSC]`,
      // Duck early and let go slowly, so the music dips under each sentence instead of pumping between words.
      `[music][voiceSC]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=600[ducked]`,
      `[voiceA][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`,
    );
    audioOut = "mixed";
  }
  // -14 LUFS, then a limiter as the guard against clipping, and the sound leaves with the picture.
  graph.push(`[${audioOut}]loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.84:level=false,aresample=48000,afade=t=out:st=${sec(Math.max(0, T - 0.4))}:d=0.4[aout]`);

  const filterGraph = graph.join(";\n");
  args.push(
    "-filter_complex", filterGraph,
    "-map", "[vout]", "-map", "[aout]",
    ...video,
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-t", sec(T),
    "-movflags", "+faststart",
    file(input.output, "output"),
  );
  return { args, filterGraph, durationSec: T };
}
