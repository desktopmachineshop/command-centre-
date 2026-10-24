import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export class FfmpegError extends Error {}

export interface RunFfmpegOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Expected output length, for progress. */
  durationSec?: number;
  onProgress?: (fraction: number, seconds: number) => void;
}

/** Windows limits a command line to 32k characters; long graphs go in a script file instead. */
const MAX_INLINE_GRAPH = 24_000;

/**
 * Runs ffmpeg directly (never through a shell) in `cwd`, so the relative file
 * names in the compositor's arguments resolve inside the render directory.
 */
export async function runFfmpeg(bin: string, args: string[], options: RunFfmpegOptions): Promise<void> {
  let finalArgs = args;
  const graphAt = args.indexOf("-filter_complex");
  if (graphAt >= 0 && (args[graphAt + 1]?.length ?? 0) > MAX_INLINE_GRAPH) {
    await writeFile(join(options.cwd, "graph.txt"), args[graphAt + 1]!);
    finalArgs = [...args.slice(0, graphAt), "-filter_complex_script", "graph.txt", ...args.slice(graphAt + 2)];
  }
  const full = ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", ...finalArgs];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, full, { cwd: options.cwd, shell: false, windowsHide: true, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-6000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const [key, value] = line.split("=", 2);
      if ((key === "out_time_us" || key === "out_time_ms") && options.durationSec) {
        const seconds = Number(value) / 1e6;
        if (Number.isFinite(seconds) && seconds >= 0) options.onProgress?.(Math.min(1, seconds / options.durationSec), seconds);
      }
    });
    child.on("error", (err) => reject(new FfmpegError(`Failed to start ffmpeg (${bin}): ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg exited with code ${code}: ${stderr.trim().split("\n").slice(-8).join("\n")}`));
    });
  });
}

function run(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Whether this ffmpeg build has a filter (e.g. `flite`, `subtitles`) or encoder (e.g. `h264_nvenc`). */
export async function ffmpegHas(bin: string, kind: "filters" | "encoders", name: string): Promise<boolean> {
  try {
    const out = await run(bin, ["-hide_banner", `-${kind}`]);
    return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(out);
  } catch {
    return false;
  }
}

export interface ProbeResult {
  durationSec: number;
  streams: { codecType: string; codecName: string; width?: number; height?: number; sampleRate?: number; channels?: number }[];
}

/** ffprobe next to ffmpeg (same folder, same naming). */
export function ffprobeFor(ffmpegBin: string): string {
  return ffmpegBin.replace(/ffmpeg(\.exe)?$/i, (_m, exe: string | undefined) => `ffprobe${exe ?? ""}`);
}

export async function probe(ffprobeBin: string, path: string): Promise<ProbeResult> {
  const out = await run(ffprobeBin, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels", "-of", "json", path]);
  const json = JSON.parse(out) as { format?: { duration?: string }; streams?: Record<string, unknown>[] };
  return {
    durationSec: Number(json.format?.duration ?? 0),
    streams: (json.streams ?? []).map((s) => ({
      codecType: String(s.codec_type),
      codecName: String(s.codec_name),
      width: s.width as number | undefined,
      height: s.height as number | undefined,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
      channels: s.channels as number | undefined,
    })),
  };
}
