import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DavinciRenderPayload } from "@cc/core";
import { defineHandler, type JobContext, JobError } from "./registry";
import { RESOLVE_JOB_PY } from "./resolve-script";
import { download } from "./video";

export { DavinciRenderPayload };

/** How long Resolve gets to stop a cancelled render before the script is killed. */
const CANCEL_GRACE_MS = 15_000;

export interface DavinciOptions {
  /** A Python 3 that can import DaVinciResolveScript with `env`. */
  python: string;
  /** Environment for Python: RESOLVE_SCRIPT_API, RESOLVE_SCRIPT_LIB and PYTHONPATH (see resolveEnv). */
  env: NodeJS.ProcessEnv;
  /** Render presets jobs may ask for. */
  presets: string[];
  /**
   * Where clips for named projects are kept (`<mediaDir>/<project>/<job id>/`), outside the job
   * folder, so a project kept in Resolve keeps finding its media. Defaults to the job folder.
   */
  mediaDir?: string;
  /** Runs this file instead of the bundled script (tests). */
  script?: string;
  fetch?: typeof fetch;
}

/** What the script reports when it finishes. */
interface ScriptDone {
  /** Rendered file name in outDir; null for a draft. */
  file: string | null;
  /** The project, when it was kept. */
  project: string | null;
  timeline: string;
  existing: boolean;
}

type ScriptEvent =
  | { type: "progress"; progress: number; message?: string }
  | ({ type: "done" } & ScriptDone)
  | { type: "error"; message: string }
  | { type: "cancelled" };

interface ScriptRequest {
  /** The project to open or create. */
  projectName: string;
  /** Delete the project afterwards if this job created it (a throwaway, not kept). */
  deleteIfCreated: boolean;
  timeline: string;
  render: boolean;
  clips: string[];
  preset: string;
  fps?: string;
  outDir: string;
  outputName: string;
}

/** A folder name for a project: its name with anything unusual replaced. */
const folderFor = (project: string) => project.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "_").slice(0, 100);

/**
 * `davinci.render` (needs `davinci`): downloads clips and has DaVinci Resolve add them end to end
 * to a timeline, then render it with a named preset and upload the file. The project is either a
 * throwaway (deleted afterwards), a new named one, or an existing one opened by name; named ones
 * can be kept open for Dave, and a `draft` builds the timeline without rendering. Resolve must be
 * running with external scripting on. Python runs a fixed script without a shell; the server's
 * payload only reaches it as validated JSON.
 */
export function davinciRenderHandler(options: DavinciOptions) {
  const http = options.fetch ?? fetch;
  return defineHandler({
    kind: "davinci.render",
    payload: DavinciRenderPayload,
    async run(payload, ctx) {
      const render = payload.mode === "render";
      if (render && !options.presets.includes(payload.preset)) {
        throw new JobError(`Render preset "${payload.preset}" isn't allowed on this PC (allowed: ${options.presets.join(", ") || "none"})`);
      }

      const named = payload.project !== undefined;
      const media = named && options.mediaDir ? join(options.mediaDir, folderFor(payload.project!), ctx.job.id) : join(ctx.dir, "media");
      const outDir = join(ctx.dir, "out");
      await mkdir(media, { recursive: true });
      await mkdir(outDir, { recursive: true });
      const clips: string[] = [];
      for (const [i, clip] of payload.clips.entries()) {
        ctx.progress((0.2 * i) / payload.clips.length, `downloading ${clip.name}`);
        const dest = join(media, clip.name);
        await download(clip.url, dest, ctx.signal, http);
        clips.push(dest);
      }

      let script = options.script;
      if (!script) {
        script = join(ctx.dir, "resolve_job.py");
        await writeFile(script, RESOLVE_JOB_PY);
      }
      const keep = payload.keepProject || !render;
      const request: ScriptRequest = {
        projectName: payload.project ?? `cc-${ctx.job.id}`,
        deleteIfCreated: !keep,
        timeline: payload.timeline,
        render,
        clips,
        preset: payload.preset,
        ...(payload.fps ? { fps: payload.fps } : {}),
        outDir,
        outputName: payload.outputName,
      };
      ctx.progress(0.2, render ? "starting DaVinci Resolve job" : "building the Resolve project");
      const done = await runResolveScript(options, script, request, ctx);
      const about = { mode: payload.mode, project: done.project, timeline: done.timeline, existing: done.existing };

      if (!render) return { ...about, outputPath: null, bytes: 0 };
      if (!done.file) throw new JobError("DaVinci Resolve finished the render but reported no file");
      const output = join(outDir, done.file);
      const bytes = (await stat(output)).size;
      if (!payload.upload) return { ...about, outputPath: output, bytes };
      if (!ctx.storage) throw new JobError("upload requested but this worker has no storage uploader");
      ctx.progress(0.98, "uploading render");
      const upload = await ctx.storage.uploadFile(output, { folder: payload.uploadFolder, signal: ctx.signal });
      return { ...about, outputPath: output, bytes, url: upload.url, upload };
    },
  });
}

/** A plain file name in outDir, never a path. */
const plainFile = (f: unknown): f is string => typeof f === "string" && /^[^\\/]+$/.test(f) && f !== "." && f !== "..";

function runResolveScript(options: DavinciOptions, script: string, request: ScriptRequest, ctx: JobContext): Promise<ScriptDone> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) return reject(new JobError("Cancelled"));
    // No `signal` on spawn: a cancel must reach the script so it can stop Resolve's render first.
    const child = spawn(options.python, [script], { shell: false, windowsHide: true, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let done: ScriptDone | null = null;
    let badFile = false;
    let failure: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.stdin.write("cancel\n");
      killTimer = setTimeout(() => child.kill(), CANCEL_GRACE_MS);
      killTimer.unref();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdin.on("error", () => {}); // the script may exit before reading everything
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let ev: ScriptEvent;
      try {
        ev = JSON.parse(line) as ScriptEvent;
      } catch {
        return; // Resolve's own output
      }
      if (ev.type === "progress" && Number.isFinite(ev.progress)) {
        ctx.progress(0.2 + 0.77 * Math.min(1, Math.max(0, ev.progress)), ev.message?.slice(0, 200));
      } else if (ev.type === "done") {
        // The script reports a file name in outDir; never let it point anywhere else.
        if (ev.file !== null && !plainFile(ev.file)) badFile = true;
        else {
          done = {
            file: ev.file,
            project: typeof ev.project === "string" ? ev.project.slice(0, 200) : null,
            timeline: typeof ev.timeline === "string" ? ev.timeline.slice(0, 200) : request.timeline,
            existing: ev.existing === true,
          };
        }
      } else if (ev.type === "error") failure = String(ev.message).slice(0, 1000);
    });
    child.on("error", (err) => {
      ctx.signal.removeEventListener("abort", onAbort);
      reject(new JobError(`Couldn't start Python (${options.python}): ${err.message}`));
    });
    child.on("close", (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      if (ctx.signal.aborted) return reject(new JobError("Cancelled"));
      if (failure) return reject(new JobError(`DaVinci Resolve: ${failure}`));
      if (badFile) return reject(new JobError("DaVinci Resolve script reported an output outside the job folder"));
      if (code === 0 && done) return resolve(done);
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      reject(new JobError(`DaVinci Resolve script exited with code ${code}${tail ? `: ${tail}` : ""}`));
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
