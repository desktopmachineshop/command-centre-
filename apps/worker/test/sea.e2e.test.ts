/**
 * The packaged worker (the desktop app's single executable) doing a real screen capture: laid
 * out like an install (cc-worker + playwright-core/ beside it), started against a real server
 * with no browser configured, it must find one, load Playwright from the folder, offer
 * `browser`, and record a capture job.
 *
 * Opt-in, since it needs a built executable: `pnpm --filter @cc/worker build:sea`, then
 * CC_SEA_WORKER=../desktop/src-tauri/binaries/cc-worker-<triple> with TEST_DATABASE_URL and
 * a Chromium (PW_CHROMIUM, default /opt/pw-browsers/chromium).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Job, WorkerNode } from "@cc/core";
import { ADMIN, DB_URL, makeServer, resetDatabase, serveServer } from "@cc/server/test/helpers";
import { sampleSpec, serveSample } from "@cc/video/sample";
import { afterAll, describe, expect, it } from "vitest";

const SEA = process.env.CC_SEA_WORKER ? resolve(process.env.CC_SEA_WORKER) : null;
const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!SEA || !DB_URL || !existsSync(CHROMIUM))("the packaged worker captures a page", () => {
  let child: ChildProcess | undefined;
  const cleanup: (() => Promise<void> | void)[] = [];
  afterAll(async () => {
    child?.kill();
    for (const fn of cleanup.reverse()) await fn();
  });

  it("finds the browser, loads Playwright beside it, offers browser and records", async () => {
    // An "install": the executable with playwright-core beside it, as Tauri lays it out.
    const install = mkdtempSync(join(tmpdir(), "cc-install-"));
    const exe = join(install, "cc-worker");
    copyFileSync(SEA!, exe);
    cpSync(join(dirname(SEA!), "playwright-core"), join(install, "playwright-core"), { recursive: true });
    // A machine with Chromium installed under its usual name, and no chromiumBin set.
    const bin = join(install, "bin");
    mkdirSync(bin);
    symlinkSync(CHROMIUM, join(bin, "chromium"));

    await resetDatabase(DB_URL!);
    const ctx = await makeServer();
    const http = await serveServer(ctx.server);
    cleanup.push(() => http.close());
    const site = await serveSample();
    cleanup.push(() => site.close());

    const output: string[] = [];
    child = spawn(exe, ["--server", http.url, "--token", ADMIN, "--name", "Packaged PC", "--work-dir", join(install, "work"), "--config", join(install, "worker.json")], {
      cwd: tmpdir(), // not the repo, so nothing resolves from its node_modules
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: install,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "",
        // A proxy and its CA, where the network needs them (the recorder download goes through it).
        ...Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
      },
    });
    child.stdout!.on("data", (d) => output.push(String(d)));
    child.stderr!.on("data", (d) => output.push(String(d)));

    const node = await until(async () => ((await ctx.api("/api/nodes")).body as WorkerNode[]).find((n) => n.online), "the worker to connect").catch((err) => {
      throw new Error(`${err.message}\n${output.join("")}`);
    });
    expect(output.join("")).toMatch(/screen capture ready with \//);
    expect(node.capabilities).toContain("browser");

    const job = (await ctx.api("/api/jobs", { method: "POST", json: { kind: "video.capture", requires: ["browser"], payload: { spec: sampleSpec(site.url), scenes: ["open-topic"] } } })).body as Job;
    const done = await until(async () => {
      const j = ((await ctx.api("/api/jobs")).body as Job[]).find((x) => x.id === job.id);
      return j && (j.status === "succeeded" || j.status === "failed") ? j : null;
    }, "the capture job", 120_000);
    expect(done.status, `${JSON.stringify(done.result)}\n${output.join("")}`).toBe("succeeded");
    const clip = (done.result as { clips: Record<string, { file: string; bytes?: number; durationSec: number }> }).clips["open-topic"]!;
    expect(clip.file).toBe("open-topic.webm");
    expect(clip.durationSec).toBeGreaterThan(2);
  }, 240_000);
});
