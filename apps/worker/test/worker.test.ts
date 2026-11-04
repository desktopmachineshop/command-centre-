import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability, Job, NodeSetup } from "@cc/core";
import { ADMIN, DB_URL, makeServer, resetDatabase, serveServer } from "@cc/server/test/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultRegistry, toWsUrl, WorkerClient, type WorkerState } from "../src";

const fakeFfmpeg = fileURLToPath(new URL("./fixtures/fake-ffmpeg.mjs", import.meta.url));

async function until<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!DB_URL)("worker against a real server", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let http: Awaited<ReturnType<typeof serveServer>>;
  let watcher: WebSocket;
  const updates: Job[] = [];
  const workers: { id: string; client: WorkerClient; states: WorkerState[] }[] = [];

  function startWorker(id: string, capabilities: Capability[], extra: { setup?: NodeSetup; onUpdate?: () => void } = {}) {
    const workDir = mkdtempSync(join(tmpdir(), "cc-worker-"));
    const states: WorkerState[] = [];
    const client = new WorkerClient({
      wsUrl: toWsUrl(http.url),
      token: ADMIN,
      node: { id, name: id, capabilities, ...(extra.setup ? { setup: extra.setup } : {}) },
      onUpdate: extra.onUpdate,
      registry: defaultRegistry({ ffmpegBin: fakeFfmpeg, claudeBin: "claude-not-installed", claudeDirs: [], workDir }),
      workDir,
      backoff: { minMs: 20, maxMs: 200 },
      progressIntervalMs: 0,
      onStatus: (s) => states.at(-1) !== s.state && states.push(s.state),
      log: () => {},
    });
    client.start();
    workers.push({ id, client, states });
    return { client, states };
  }

  const submit = async (kind: string, requires: Capability[], payload: Record<string, unknown>) =>
    (await ctx.api("/api/jobs", { method: "POST", json: { kind, requires, payload } })).body as Job;
  const finished = (id: string) =>
    until(() => [...updates].reverse().find((j) => j.id === id && (j.status === "succeeded" || j.status === "failed")), `job ${id}`);

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer();
    http = await serveServer(ctx.server);
    // A dashboard client, to watch job updates the way the PWA does.
    watcher = new WebSocket(toWsUrl(http.url));
    watcher.addEventListener("open", () => watcher.send(JSON.stringify({ type: "hello", role: "client", token: ADMIN })));
    watcher.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "job.updated") updates.push(msg.job);
    });
  });
  afterAll(async () => {
    for (const w of workers) w.client.stop();
    watcher?.close();
    await http?.close();
    await ctx?.server.stop();
  });

  it("dispatches to the capable worker and streams progress to completion", async () => {
    const plain = startWorker("plain", []);
    const editor = startWorker("editor", ["ffmpeg", "gpu"]);
    await until(() => plain.client.state.state === "connected" && editor.client.state.state === "connected", "workers to connect");

    const job = await submit("ffmpeg.run", ["ffmpeg"], { args: ["-t", "10", "-c:v", "libx264", "{output}"], outputName: "out.mp4" });
    const done = await finished(job.id);
    expect(done).toMatchObject({ status: "succeeded", nodeId: "editor", progress: 1 });
    const result = done.result as { outputPath: string; bytes: number };
    expect(existsSync(result.outputPath)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    const running = updates.filter((j) => j.id === job.id && j.status === "running").map((j) => j.progress!);
    expect(running.length).toBeGreaterThanOrEqual(3);
    expect(running.every((p) => p > 0 && p < 1)).toBe(true);

    const echo = await submit("echo", [], { message: "hi", steps: 1 });
    expect(await finished(echo.id)).toMatchObject({ status: "succeeded", result: { echo: "hi" } });
  });

  it("uploads ffmpeg output to storage when asked and returns its public URL", async () => {
    const job = await submit("ffmpeg.run", ["ffmpeg"], { args: ["-t", "1", "{output}"], outputName: "render.mp4", upload: true });
    const done = await finished(job.id);
    expect(done).toMatchObject({ status: "succeeded" });
    const result = done.result as { url: string; bytes: number; upload: { id: string; folder: string } };
    expect(result.upload.folder).toBe("renders");
    expect(result.url).toMatch(/\/media\/[a-f0-9]{32}\.mp4$/);
    const served = await ctx.server.app.request(new URL(result.url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("video/mp4");
    expect((await served.arrayBuffer()).byteLength).toBe(result.bytes);
  });

  it("fails unknown kinds and invalid payloads cleanly, without running anything", async () => {
    const unknown = await submit("shell.exec", [], { cmd: "format c:" });
    const bad = await submit("ffmpeg.run", ["ffmpeg"], { args: ["-i", "C:\\Users\\dave\\secret.mp4", "{output}"], outputName: "x.mp4" });
    expect(await finished(unknown.id)).toMatchObject({ status: "failed", result: { error: expect.stringMatching(/Unknown job kind "shell.exec"/) } });
    const failed = await finished(bad.id);
    expect(failed).toMatchObject({ status: "failed", nodeId: "editor", result: { error: expect.stringMatching(/Invalid ffmpeg.run payload/) } });
  });

  it("reconnects after the server drops the connection and keeps taking jobs", async () => {
    const editor = workers.find((w) => w.id === "editor")!;
    const before = editor.states.length;
    http.dropConnections();
    await until(() => workers.every((w) => w.client.state.state === "connected") && editor.states.length > before + 1, "reconnect");
    expect(editor.states.slice(before)).toEqual(expect.arrayContaining(["disconnected", "connecting", "connected"]));

    // The watcher was dropped too; reconnect it so we can see the next job.
    watcher = new WebSocket(toWsUrl(http.url));
    await new Promise((r) => watcher.addEventListener("open", r));
    watcher.send(JSON.stringify({ type: "hello", role: "client", token: ADMIN }));
    watcher.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "job.updated") updates.push(msg.job);
    });
    await new Promise((r) => setTimeout(r, 50));

    const job = await submit("ffmpeg.run", ["ffmpeg"], { args: ["{output}"], outputName: "again.mp4" });
    expect(await finished(job.id)).toMatchObject({ status: "succeeded", nodeId: "editor" });
    const nodes = (await ctx.api("/api/nodes")).body as { id: string; online: boolean }[];
    expect(nodes.filter((n) => n.online).map((n) => n.id).sort()).toEqual(["editor", "plain"]);
  });

  it("asks its desktop app to update when Dave presses Update now, after the job it's running", async () => {
    const asked: true[] = [];
    const setup: NodeSetup = { platform: "win32", installer: null, installed: [], appVersion: "0.1.40", remoteUpdate: true };
    const studio = startWorker("studio", ["davinci"], { setup, onUpdate: () => asked.push(true) });
    await until(() => studio.client.state.state === "connected", "studio to connect");

    const job = await submit("echo", ["davinci"], { steps: 3, delayMs: 100 });
    await until(() => studio.client.state.job?.id === job.id, "the job to start");
    const res = await ctx.api("/api/nodes/studio/update", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([]); // still busy: the update would stop the job
    expect(await finished(job.id)).toMatchObject({ status: "succeeded", nodeId: "studio" });
    await until(() => asked.length === 1, "the update request");

    // Idle: straight away.
    expect((await ctx.api("/api/nodes/studio/update", { method: "POST" })).status).toBe(202);
    await until(() => asked.length === 2, "the second update request");

    // A computer whose app can't take it (an older app, or a worker run by hand) is refused.
    const res2 = await ctx.api("/api/nodes/editor/update", { method: "POST" });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/tray menu/);
    expect((await ctx.api("/api/nodes/nope/update", { method: "POST" })).status).toBe(404);
  });
});
