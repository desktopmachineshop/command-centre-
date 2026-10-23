import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "@cc/core";
import { describe, expect, it } from "vitest";
import { FfmpegPayload } from "../src/handlers/ffmpeg";
import {
  backoffDelay,
  claudeHandler,
  detectCapabilities,
  echoHandler,
  ffmpegHandler,
  HandlerRegistry,
  type JobContext,
  loadConfig,
  toWsUrl,
  which,
} from "../src";

const fakeFfmpeg = fileURLToPath(new URL("./fixtures/fake-ffmpeg.mjs", import.meta.url));
const fakeClaude = fileURLToPath(new URL("../../../packages/agent-runtime/test/fixtures/fake-claude.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "cc-worker-"));

function job(kind: string, payload: Record<string, unknown>): Job {
  const now = new Date().toISOString();
  return { id: "job-1", kind, requires: [], payload, status: "assigned", nodeId: "n", progress: null, result: null, createdAt: now, updatedAt: now };
}

function context(j: Job, progress: [number, string?][] = []): JobContext {
  return { job: j, dir: tmp(), signal: new AbortController().signal, progress: (p, m) => progress.push([p, m]) };
}

describe("config", () => {
  it("turns server URLs into the /ws endpoint", () => {
    expect(toWsUrl("https://cc.example.com")).toBe("wss://cc.example.com/ws");
    expect(toWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/ws");
    expect(toWsUrl("wss://cc.example.com/ws")).toBe("wss://cc.example.com/ws");
    expect(() => toWsUrl("ftp://x")).toThrow(/Unsupported/);
  });

  it("generates a node id once and keeps it; flags beat env beat the file", () => {
    const dir = tmp();
    const path = join(dir, "worker.json");
    writeFileSync(path, JSON.stringify({ serverUrl: "https://file.example", token: "file-token", nodeName: "File", desktop: { enabled: true } }));

    const first = loadConfig(["--config", path], { CC_WORKER_TOKEN: "env-token" });
    expect(first).toMatchObject({ wsUrl: "wss://file.example/ws", token: "env-token", nodeName: "File", workDir: join(dir, "work"), capabilities: null });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.nodeId).toBe(first.nodeId);
    expect(saved.desktop).toEqual({ enabled: true }); // other apps' keys survive

    const second = loadConfig(["--config", path, "--token", "flag-token", "--capabilities", "ffmpeg,gpu"], { CC_WORKER_TOKEN: "env-token" });
    expect(second).toMatchObject({ nodeId: first.nodeId, token: "flag-token", capabilities: ["ffmpeg", "gpu"] });
  });

  it("explains missing settings and rejects unknown capabilities", () => {
    const path = join(tmp(), "worker.json");
    expect(() => loadConfig(["--config", path], {})).toThrow(/No server URL/);
    expect(() => loadConfig(["--config", path, "--server", "http://x", "--token", "t", "--capabilities", "teleport"], {})).toThrow();
  });
});

describe("capabilities", () => {
  it("detects binaries on PATH and applies overrides", async () => {
    const bin = tmp();
    for (const name of ["ffmpeg", "claude"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      chmodSync(join(bin, name), 0o755);
    }
    const env = { PATH: bin };
    expect(which("ffmpeg", env, "linux")).toBe(join(bin, "ffmpeg"));
    expect(which("nope", env, "linux")).toBeNull();

    const caps = await detectCapabilities({ ffmpegBin: "ffmpeg", claudeBin: "claude", env, platform: "linux" });
    expect(caps.sort()).toEqual(["claude-local", "ffmpeg"]);
    const overridden = await detectCapabilities({ ffmpegBin: "ffmpeg", claudeBin: "claude", env, platform: "linux", overrides: { ffmpeg: false, davinci: true } });
    expect(overridden.sort()).toEqual(["claude-local", "davinci"]);
  });
});

describe("backoff", () => {
  it("doubles up to the cap, with jitter in the top half", () => {
    expect(backoffDelay(0, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 60_000, () => 0.5)).toBe(45_000);
  });
});

describe("handler registry", () => {
  const registry = new HandlerRegistry().register(echoHandler).register(ffmpegHandler(fakeFfmpeg));

  it("runs a known kind", async () => {
    const progress: [number, string?][] = [];
    expect(await registry.run(context(job("echo", { message: "hi" }), progress))).toEqual({ echo: "hi" });
    expect(progress.length).toBe(2);
  });

  it("rejects unknown kinds and invalid payloads", async () => {
    await expect(registry.run(context(job("rm -rf", {})))).rejects.toThrow(/Unknown job kind "rm -rf"/);
    await expect(registry.run(context(job("echo", { steps: "lots" })))).rejects.toThrow(/Invalid echo payload/);
  });
});

describe("ffmpeg.run", () => {
  const ok = (args: string[], extra: Record<string, unknown> = {}) =>
    FfmpegPayload.safeParse({ args, outputName: "out.mp4", inputUrl: "https://cdn.example/in.mp4", ...extra }).success;

  it("accepts ordinary transcodes", () => {
    expect(ok(["-i", "{input}", "-c:v", "libx264", "-vf", "scale=iw/2:-2,fps=30", "-ss", "00:00:05", "{output}"])).toBe(true);
    expect(ok(["-f", "lavfi", "-t", "1", "-c:v", "libx264", "{output}"], { inputUrl: undefined })).toBe(true);
  });

  it("blocks paths, URLs, extra outputs and dangerous options", () => {
    expect(ok(["-i", "/etc/passwd", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "C:\\Windows\\out.mp4", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "..\\..\\evil.exe", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "-vf", "movie=secret.mp4", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "-vf", "drawtext=fontfile=/usr/share/x.ttf", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "http://evil/x", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "-filter_script", "f.txt", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "-/vf", "f.txt", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "{output}", "-c", "copy"])).toBe(false);
    expect(ok(["-i", "{input}", "a; rm -rf ~\n", "{output}"])).toBe(false);
    expect(ok(["-i", "{input}", "{output}"], { outputName: "../x.mp4" })).toBe(false);
    expect(ok(["-i", "{input}", "{output}"], { inputUrl: "file:///etc/passwd" })).toBe(false);
  });

  it("runs ffmpeg without a shell and reports progress from -progress output", async () => {
    const progress: [number, string?][] = [];
    const ctx = context(job("ffmpeg.run", { args: ["-f", "lavfi", "-i", "{input}", "{output}"], outputName: "out.mp4" }), progress);
    // -i needs {input}, which needs inputUrl: this payload is invalid.
    await expect(new HandlerRegistry().register(ffmpegHandler(fakeFfmpeg)).run(ctx)).rejects.toThrow(/inputUrl/);

    const good = context(job("ffmpeg.run", { args: ["-t", "10", "-c:v", "libx264", "{output}"], outputName: "clip one.mp4" }), progress);
    const result = (await ffmpegHandler(fakeFfmpeg).run(FfmpegPayload.parse(good.job.payload), good)) as { outputPath: string };
    expect(result.outputPath).toBe(join(good.dir, "clip one.mp4"));
    expect(JSON.parse(readFileSync(result.outputPath, "utf8"))).toEqual([
      "-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", "-t", "10", "-c:v", "libx264", result.outputPath,
    ]);
    const fractions = progress.map(([p]) => p);
    expect(fractions.at(-1)).toBeCloseTo(0.99);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });

  it("fails with ffmpeg's error output", async () => {
    const prev = process.env.FAKE_FFMPEG_EXIT;
    process.env.FAKE_FFMPEG_EXIT = "1";
    try {
      const ctx = context(job("ffmpeg.run", { args: ["{output}"], outputName: "o.mp4" }));
      await expect(ffmpegHandler(fakeFfmpeg).run(FfmpegPayload.parse(ctx.job.payload), ctx)).rejects.toThrow(/code 1: .*Conversion failed/s);
    } finally {
      if (prev === undefined) delete process.env.FAKE_FFMPEG_EXIT;
      else process.env.FAKE_FFMPEG_EXIT = prev;
    }
  });
});

describe("claude.local", () => {
  it("runs Claude Code headless in an allowed directory", async () => {
    const root = tmp();
    const project = join(root, "project");
    mkdirSync(project);
    const handler = claudeHandler({ bin: fakeClaude, allowedDirs: [root] });
    const progress: [number, string?][] = [];
    const ctx = context(job("claude.local", { prompt: "summarise", cwd: project }), progress);
    const result = await new HandlerRegistry().register(handler).run(ctx);
    expect(result).toEqual({ result: "answer to summarise", sessionId: "sess-1", costUsd: 0.01 });
    expect(progress.some(([, m]) => m === "tool: mcp__brain__search")).toBe(true);
  });

  it("refuses directories outside the allowed ones", async () => {
    const handler = claudeHandler({ bin: fakeClaude, allowedDirs: [tmp()] });
    const ctx = context(job("claude.local", { prompt: "x", cwd: tmp() }));
    await expect(new HandlerRegistry().register(handler).run(ctx)).rejects.toThrow(/outside the allowed/);
    expect(existsSync(ctx.dir)).toBe(true);
  });
});
