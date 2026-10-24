import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { defineHandler, JobError } from "./registry";

/** Options that read or write files we don't control, or that we set ourselves. */
const BLOCKED_OPTIONS = new Set([
  "-progress", "-stats", "-nostats", "-y", "-n", "-report", "-vstats", "-vstats_file", "-passlogfile",
  "-filter_script", "-filter_complex_script", "-dump_attachment", "-attach", "-protocol_whitelist",
  "-protocol_blacklist", "-sdp_file", "-init_hw_device", "-filter_hw_device", "-stdin",
]);
/** Filters that open files or sockets by themselves. */
const BLOCKED_FILTERS = /\b(a?movie|sendcmd|asendcmd|zmq|azmq|ladspa|lv2|frei0r)\s*=/i;
/** An absolute path, home path, UNC path, URL or parent-directory hop anywhere in an argument. */
const PATH_LIKE = /(^|[=,:;'"|])\s*(\/|~|\\\\|[a-z]:[\\/])|:\/\/|(^|[\\/=])\.\.([\\/]|$)/i;

const SafeArg = z
  .string()
  .max(4096)
  .refine((a) => !/[\0\r\n]/.test(a), "control characters are not allowed");

export const FfmpegPayload = z
  .object({
    /** ffmpeg arguments; use `{input}` for the downloaded input and end with `{output}`. */
    args: z.array(SafeArg).min(1).max(200),
    inputUrl: z.url({ protocol: /^https?$/ }).optional(),
    outputName: z
      .string()
      .regex(/^[\w][\w. -]{0,199}$/, "plain file name only")
      .refine((n) => !n.includes(".."), "plain file name only"),
    /** Input duration, for progress when ffmpeg can't report it. */
    durationSec: z.number().positive().optional(),
    /** Upload the output to Command Centre storage and return its URL (the result's `upload`). */
    upload: z.boolean().default(false),
    uploadFolder: z.enum(["renders", "media", "footage", "assets"]).default("renders"),
  })
  .superRefine((p, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["args"], message });
    if (p.args.at(-1) !== "{output}") issue("the last argument must be {output}");
    if (p.args.filter((a) => a.includes("{output}")).length !== 1) issue("{output} must appear exactly once");
    p.args.forEach((arg, i) => {
      if (BLOCKED_OPTIONS.has(arg) || arg.startsWith("-/")) issue(`option ${arg} is not allowed`);
      if (arg === "-i" && p.args[i + 1] !== "{input}") issue("-i only accepts {input}");
      if (BLOCKED_FILTERS.test(arg)) issue(`filter in "${arg}" is not allowed`);
      if (PATH_LIKE.test(arg)) issue(`"${arg}" looks like a path or URL; use {input}/{output}`);
    });
    if (p.args.some((a) => a.includes("{input}")) && !p.inputUrl) issue("{input} needs inputUrl");
  });

/** Parses `HH:MM:SS.ss` (as in ffmpeg's `Duration:` line) into seconds. */
export function parseClock(text: string): number | null {
  const m = /(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

async function download(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new JobError(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

/**
 * Runs ffmpeg (spawned directly, never through a shell) inside the job
 * directory. Progress comes from `-progress pipe:1`.
 */
export function ffmpegHandler(bin: string) {
  return defineHandler({
    kind: "ffmpeg.run",
    payload: FfmpegPayload,
    async run(payload, ctx) {
      let input: string | null = null;
      if (payload.inputUrl) {
        const ext = extname(new URL(payload.inputUrl).pathname).replace(/[^\w.]/g, "").slice(0, 10);
        input = join(ctx.dir, `input${ext}`);
        ctx.progress(0, "downloading input");
        await download(payload.inputUrl, input, ctx.signal);
      }
      const output = join(ctx.dir, payload.outputName);
      const args = payload.args.map((a) => a.replaceAll("{output}", output).replaceAll("{input}", input ?? ""));
      const fullArgs = ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", ...args];

      ctx.progress(0.05, "running ffmpeg");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, fullArgs, { cwd: ctx.dir, shell: false, windowsHide: true, signal: ctx.signal, stdio: ["ignore", "pipe", "pipe"] });
        let duration = payload.durationSec ?? null;
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4000);
          if (duration === null) {
            const line = /Duration: ([\d:.]+)/.exec(stderr);
            if (line?.[1]) duration = parseClock(line[1]);
          }
        });
        createInterface({ input: child.stdout }).on("line", (line) => {
          const [key, value] = line.split("=", 2);
          if (key === "out_time_us" || key === "out_time_ms") {
            // Both are microseconds (out_time_ms is misnamed in ffmpeg).
            const seconds = Number(value) / 1e6;
            if (duration && Number.isFinite(seconds)) ctx.progress(0.05 + 0.94 * Math.min(1, seconds / duration), `encoded ${seconds.toFixed(1)}s`);
          }
        });
        child.on("error", (err) => reject(new JobError(`Failed to start ffmpeg (${bin}): ${err.message}`)));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new JobError(`ffmpeg exited with code ${code}: ${stderr.trim().split("\n").slice(-5).join("\n")}`));
        });
      });

      const bytes = (await stat(output)).size;
      if (!payload.upload) return { outputPath: output, bytes };
      if (!ctx.storage) throw new JobError("upload requested but this worker has no storage uploader");
      ctx.progress(0.99, "uploading output");
      const upload = await ctx.storage.uploadFile(output, { folder: payload.uploadFolder, signal: ctx.signal });
      return { outputPath: output, bytes, url: upload.url, upload };
    },
  });
}
