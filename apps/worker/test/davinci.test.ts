import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "@cc/core";
import { describe, expect, it } from "vitest";
import { DavinciRenderPayload, davinciRenderHandler, defaultRegistry, type JobContext, resolveEnv } from "../src";

const fakeModuleDir = fileURLToPath(new URL("./fixtures/fake-resolve", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "cc-davinci-"));

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function job(payload: Record<string, unknown>): Job {
  const now = new Date().toISOString();
  return { id: "job-7", kind: "davinci.render", requires: ["davinci"], payload, status: "assigned", nodeId: "n", progress: null, result: null, createdAt: now, updatedAt: now };
}

function context(payload: Record<string, unknown>, signal = new AbortController().signal) {
  const progress: [number, string?][] = [];
  const ctx: JobContext = { job: job(payload), dir: tmp(), signal, progress: (p, m) => progress.push([p, m]) };
  return { ctx, progress };
}

const clips = [
  { url: "https://cdn.example/a.mp4", name: "a.mp4" },
  { url: "https://cdn.example/b.mov", name: "b.mov" },
];
const base = { clips, preset: "YouTube - 1080p", outputName: "promo cut", upload: false };
const fakeFetch = (async () => new Response("clip-bytes")) as unknown as typeof fetch;

/** The real bundled script, run by python3 against the fake DaVinciResolveScript module. */
function handler(mode: string, log: string, extra: { existing?: Record<string, string[]>; mediaDir?: string } = {}) {
  return davinciRenderHandler({
    python: "python3",
    env: {
      ...process.env,
      PYTHONPATH: fakeModuleDir,
      PYTHONDONTWRITEBYTECODE: "1",
      FAKE_RESOLVE: mode,
      FAKE_RESOLVE_LOG: log,
      FAKE_RESOLVE_EXISTING: JSON.stringify(extra.existing ?? {}),
    },
    presets: ["YouTube - 1080p"],
    mediaDir: extra.mediaDir,
    fetch: fakeFetch,
  });
}

const calls = (log: string) =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown[]) : [];

describe("davinci.render payload", () => {
  const ok = (extra: Record<string, unknown>) => DavinciRenderPayload.safeParse({ ...base, ...extra }).success;

  it("accepts plain clip names and http(s) URLs", () => {
    expect(ok({})).toBe(true);
    expect(ok({ fps: "29.97" })).toBe(true);
  });

  it("rejects paths, other schemes, duplicate names and odd output names", () => {
    expect(ok({ clips: [{ url: "https://x/a.mp4", name: "../a.mp4" }] })).toBe(false);
    expect(ok({ clips: [{ url: "https://x/a.mp4", name: "C:\\a.mp4" }] })).toBe(false);
    expect(ok({ clips: [{ url: "file:///etc/passwd", name: "a.mp4" }] })).toBe(false);
    expect(ok({ clips: [clips[0], { ...clips[1], name: "A.MP4" }] })).toBe(false);
    expect(ok({ clips: [] })).toBe(false);
    expect(ok({ outputName: "../out" })).toBe(false);
    expect(ok({ outputName: "out.mp4" })).toBe(false);
    expect(ok({ fps: "1000" })).toBe(false);
    expect(ok({ project: "../Projects" })).toBe(false);
    expect(ok({ project: "C:\\x" })).toBe(false);
    expect(ok({ timeline: "a/b", project: "Shop tour" })).toBe(false);
  });

  it("knows which project options go together", () => {
    expect(ok({ project: "Shop tour", keepProject: true })).toBe(true);
    expect(ok({ project: "Shop tour", mode: "draft" })).toBe(true);
    expect(ok({ project: "Shop tour", clips: [] })).toBe(true); // re-render an existing project
    expect(ok({ clips: [] })).toBe(false);
    expect(ok({ keepProject: true })).toBe(false); // kept projects need a name
    expect(ok({ mode: "draft" })).toBe(false);
    expect(ok({ mode: "draft", project: "Shop tour", clips: [] })).toBe(false);
  });
});

describe("davinci.render", () => {
  it("refuses presets that aren't on the worker's list", async () => {
    const { ctx } = context({ ...base, preset: "Custom Evil" });
    const h = handler("ok", join(ctx.dir, "log"));
    await expect(h.run(DavinciRenderPayload.parse(ctx.job.payload), ctx)).rejects.toThrow(/isn't allowed on this PC/);
  });

  it("is only registered when the node has the davinci capability", () => {
    const config = { ffmpegBin: "ffmpeg", claudeBin: "claude", claudeDirs: [], workDir: tmpdir() };
    expect(defaultRegistry(config).kinds()).not.toContain("davinci.render");
    expect(defaultRegistry(config, ["davinci"]).kinds()).toContain("davinci.render");
  });

  it("points Python at Resolve's scripting module, keeping values already set", () => {
    const env = resolveEnv("linux", { PYTHONPATH: "/mine" });
    expect(env).toMatchObject({ RESOLVE_SCRIPT_API: "/opt/resolve/Developer/Scripting", RESOLVE_SCRIPT_LIB: "/opt/resolve/libs/Fusion/fusionscript.so" });
    expect(env.PYTHONPATH).toBe("/mine:/opt/resolve/Developer/Scripting/Modules");
    expect(resolveEnv("linux", { RESOLVE_SCRIPT_API: "/x" }).PYTHONPATH).toBe("/x/Modules");
  });

  it("fails clearly when Python isn't there", async () => {
    const { ctx } = context(base);
    const h = davinciRenderHandler({ python: "python-not-installed", env: process.env, presets: ["YouTube - 1080p"], fetch: fakeFetch });
    await expect(h.run(DavinciRenderPayload.parse(ctx.job.payload), ctx)).rejects.toThrow(/Couldn't start Python/);
  });

  describe.skipIf(!hasPython())("with the bundled script and a fake Resolve", () => {
    it("imports the clips, renders with the preset, cleans up and reopens the previous project", async () => {
      const { ctx, progress } = context({ ...base, fps: "25" });
      const log = join(ctx.dir, "log");
      const result = (await handler("ok", log).run(DavinciRenderPayload.parse(ctx.job.payload), ctx)) as { outputPath: string; bytes: number };

      expect(result.outputPath).toBe(join(ctx.dir, "out", "promo cut.mp4"));
      expect(readFileSync(result.outputPath, "utf8")).toBe("rendered");
      expect(readFileSync(join(ctx.dir, "media", "a.mp4"), "utf8")).toBe("clip-bytes");
      const names = calls(log).map((c) => c[0]);
      expect(names).toEqual([
        "LoadProject", "CreateProject", "SetSetting", "ImportMedia", "CreateTimelineFromClips", "SetCurrentTimeline", "LoadRenderPreset",
        "SetRenderSettings", "StartRendering", "DeleteRenderJob", "CloseProject", "DeleteProject", "LoadProject",
      ]);
      expect(result).toMatchObject({ mode: "render", project: null, existing: false });
      expect(calls(log)).toContainEqual(["CreateProject", "cc-job-7"]);
      expect(calls(log)).toContainEqual(["ImportMedia", ["a.mp4", "b.mov"]]);
      expect(calls(log)).toContainEqual(["LoadProject", "Dave's edit"]);
      const fractions = progress.map(([p]) => p);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(Math.max(...fractions)).toBeLessThan(1);
    });

    it("keeps a new named project open, with its clips outside the job folder", async () => {
      const mediaDir = tmp();
      const { ctx } = context({ ...base, project: "Shop tour", keepProject: true });
      const log = join(ctx.dir, "log");
      const result = await handler("ok", log, { mediaDir }).run(DavinciRenderPayload.parse(ctx.job.payload), ctx);
      expect(result).toMatchObject({ mode: "render", project: "Shop tour", timeline: "Main", existing: false, outputPath: join(ctx.dir, "out", "promo cut.mp4") });
      expect(readFileSync(join(mediaDir, "Shop_tour", "job-7", "a.mp4"), "utf8")).toBe("clip-bytes");
      const names = calls(log).map((c) => c[0]);
      expect(names.slice(-2)).toEqual(["DeleteRenderJob", "SaveProject"]);
      expect(names).not.toContain("DeleteProject");
      expect(names).not.toContain("CloseProject");
    });

    it("builds a draft without rendering", async () => {
      const { ctx } = context({ ...base, project: "Shop tour", mode: "draft", preset: "Not On The List" });
      const log = join(ctx.dir, "log");
      const result = await handler("ok", log, { mediaDir: tmp() }).run(DavinciRenderPayload.parse(ctx.job.payload), ctx);
      expect(result).toEqual({ mode: "draft", project: "Shop tour", timeline: "Main", existing: false, outputPath: null, bytes: 0 });
      const names = calls(log).map((c) => c[0]);
      expect(names).toContain("CreateTimelineFromClips");
      expect(names).not.toContain("StartRendering");
      expect(names.at(-1)).toBe("SaveProject");
    });

    it("adds clips to an existing project's timeline instead of starting a new one", async () => {
      const existing = { "Shop tour": ["Rough cut", "Main"] };
      const { ctx } = context({ ...base, project: "Shop tour" });
      const log = join(ctx.dir, "log");
      const result = await handler("ok", log, { existing, mediaDir: tmp() }).run(DavinciRenderPayload.parse(ctx.job.payload), ctx);
      expect(result).toMatchObject({ project: "Shop tour", existing: true });
      const all = calls(log);
      expect(all.map((c) => c[0])).not.toContain("CreateProject");
      expect(all.map((c) => c[0])).not.toContain("CreateTimelineFromClips");
      expect(all).toContainEqual(["AppendToTimeline", "Main", 2]);
      expect(all).toContainEqual(["StartRendering", "job-1", "Main", 3]); // 1 clip already there + 2 added
      expect(all.at(-1)).toEqual(["SaveProject", "Shop tour"]); // existing projects are never deleted

      // A new timeline in the same project, and a plain re-render with no clips.
      const again = context({ ...base, project: "Shop tour", timeline: "Teaser" });
      const log2 = join(again.ctx.dir, "log");
      await handler("ok", log2, { existing, mediaDir: tmp() }).run(DavinciRenderPayload.parse(again.ctx.job.payload), again.ctx);
      expect(calls(log2)).toContainEqual(["CreateTimelineFromClips", "Teaser", 2]);
      const rerender = context({ ...base, project: "Shop tour", clips: [], timeline: "Rough cut" });
      const log3 = join(rerender.ctx.dir, "log");
      await handler("ok", log3, { existing, mediaDir: tmp() }).run(DavinciRenderPayload.parse(rerender.ctx.job.payload), rerender.ctx);
      expect(calls(log3).map((c) => c[0])).not.toContain("ImportMedia");
      expect(calls(log3)).toContainEqual(["StartRendering", "job-1", "Rough cut", 1]);
    });

    it("leaves an existing project as it was saved when the job fails", async () => {
      const existing = { "Shop tour": ["Main"] };
      const { ctx } = context({ ...base, project: "Shop tour", clips: [], timeline: "Missing" });
      const log = join(ctx.dir, "log");
      await expect(handler("ok", log, { existing, mediaDir: tmp() }).run(DavinciRenderPayload.parse(ctx.job.payload), ctx)).rejects.toThrow(
        /project Shop tour has no timeline called Missing/,
      );
      const names = calls(log).map((c) => c[0]);
      expect(names).toContain("CloseProject");
      expect(names).not.toContain("SaveProject");
      expect(names).not.toContain("DeleteProject");
      expect(calls(log).at(-1)).toEqual(["LoadProject", "Dave's edit"]);
    });

    it("reports Resolve's own errors", async () => {
      for (const [mode, message] of [["not-running", /Resolve isn't running/], ["bad-preset", /no render preset called YouTube - 1080p/]] as const) {
        const { ctx } = context(base);
        const log = join(ctx.dir, "log");
        await expect(handler(mode, log).run(DavinciRenderPayload.parse(ctx.job.payload), ctx)).rejects.toThrow(message);
        if (mode === "bad-preset") expect(calls(log).map((c) => c[0])).toContain("DeleteProject");
      }
    });

    it("stops Resolve's render when the job is cancelled", async () => {
      const abort = new AbortController();
      const { ctx, progress } = context(base, abort.signal);
      const log = join(ctx.dir, "log");
      const running = handler("hang", log).run(DavinciRenderPayload.parse(ctx.job.payload), ctx);
      await expect.poll(() => progress.some(([, m]) => m?.startsWith("rendering")), { timeout: 10_000 }).toBe(true);
      abort.abort();
      await expect(running).rejects.toThrow(/Cancelled/);
      const names = calls(log).map((c) => c[0]);
      expect(names).toContain("StopRendering");
      expect(names).toContain("DeleteProject");
    });
  });

  it("never accepts an output path from the script", async () => {
    const { ctx } = context(base);
    const script = join(ctx.dir, "sneaky.mjs");
    writeFileSync(script, `process.stdin.once("data", () => { console.log(JSON.stringify({ type: "done", file: "../../etc/passwd" })); process.exit(0); });`);
    const h = davinciRenderHandler({ python: process.execPath, script, env: process.env, presets: ["YouTube - 1080p"], fetch: fakeFetch });
    await expect(h.run(DavinciRenderPayload.parse(ctx.job.payload), ctx)).rejects.toThrow(/reported an output outside the job folder/);
  });
});
