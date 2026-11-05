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
function handler(mode: string, log: string) {
  return davinciRenderHandler({
    python: "python3",
    env: { ...process.env, PYTHONPATH: fakeModuleDir, PYTHONDONTWRITEBYTECODE: "1", FAKE_RESOLVE: mode, FAKE_RESOLVE_LOG: log },
    presets: ["YouTube - 1080p"],
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
        "CreateProject", "SetSetting", "ImportMedia", "CreateTimelineFromClips", "LoadRenderPreset", "SetRenderSettings",
        "StartRendering", "DeleteRenderJob", "CloseProject", "DeleteProject", "LoadProject",
      ]);
      expect(calls(log)).toContainEqual(["CreateProject", "cc-job-7"]);
      expect(calls(log)).toContainEqual(["ImportMedia", ["a.mp4", "b.mov"]]);
      expect(calls(log)).toContainEqual(["LoadProject", "Dave's edit"]);
      const fractions = progress.map(([p]) => p);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(Math.max(...fractions)).toBeLessThan(1);
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
    await expect(h.run(DavinciRenderPayload.parse(ctx.job.payload), ctx)).rejects.toThrow(/exited with code 0/);
  });
});
