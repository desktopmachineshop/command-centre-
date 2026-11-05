import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, SetupComponentId } from "@cc/core";
import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { detectSetup, findWinget, HandlerRegistry, type JobContext, mergePath, type RunCommand, refreshProcessPath, setupHandler, wingetArgs } from "../src";

const job = (payload: Record<string, unknown>): Job => ({
  id: "j1",
  kind: "setup.install",
  requires: [],
  payload,
  status: "assigned",
  nodeId: "pc",
  targetNodeId: "pc",
  progress: null,
  result: null,
  createdAt: "",
  updatedAt: "",
});

function harness(
  exitCodes: Record<string, number> = {},
  platform: NodeJS.Platform = "win32",
  opts: { hasBrowser?: boolean; captureAfter?: { ready: boolean; why?: string }; installedAfter?: SetupComponentId[]; output?: string } = {},
) {
  const calls: string[][] = [];
  const progress: string[] = [];
  let refreshed = 0;
  const run: RunCommand = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const id = args[args.indexOf("--id") + 1]!;
    const code = exitCodes[id] ?? 0;
    return { code, output: opts.output ?? (code ? `Downloading\n██████▒▒ 10 MB / 20 MB\nInstaller failed with exit code: ${code}\n` : "Successfully installed") };
  };
  const registry = new HandlerRegistry().register(
    setupHandler({ platform, run, winget: () => "C:\\winget.exe", refreshPath: async () => {}, hasBrowser: () => opts.hasBrowser ?? false }),
  );
  const runJob = (payload: Record<string, unknown>) =>
    registry.run({
      job: job(payload),
      dir: tmpdir(),
      signal: new AbortController().signal,
      progress: (_p, m) => m && progress.push(m),
      refresh: async () => {
        refreshed++;
        return { capabilities: [], setup: { platform, installer: "winget" as const, installed: opts.installedAfter ?? [], ...(opts.captureAfter ? { capture: opts.captureAfter } : {}) } };
      },
    } satisfies JobContext);
  return { calls, progress, runJob, refreshed: () => refreshed };
}

describe("setup.install", () => {
  it("installs each catalog component with winget, quietly, then reports what the computer has", async () => {
    const h = harness();
    const result = await h.runJob({ role: "media", components: ["ffmpeg", "browser"] });
    expect(result).toEqual({ role: "media", installed: ["ffmpeg", "browser"] });
    expect(h.calls).toEqual([
      ["C:\\winget.exe", ...wingetArgs("Gyan.FFmpeg")],
      ["C:\\winget.exe", ...wingetArgs("Google.Chrome")],
    ]);
    expect(h.calls[0]).toEqual(expect.arrayContaining(["--silent", "--exact", "--accept-package-agreements"]));
    expect(h.progress).toEqual(["Installing ffmpeg", "Installing Screen capture", "Checking what's installed"]);
    expect(h.refreshed()).toBe(1);
  });

  it("doesn't install Chrome when Edge is there, only sets capture up again, and says why if it's still off", async () => {
    const ok = harness({}, "win32", { hasBrowser: true, captureAfter: { ready: true } });
    expect(await ok.runJob({ role: "media", components: ["browser"] })).toEqual({ role: "media", installed: ["browser"] });
    expect(ok.calls).toEqual([]);
    expect(ok.refreshed()).toBe(1);

    const off = harness({}, "win32", { hasBrowser: true, captureAfter: { ready: false, why: "Playwright's video recorder couldn't be downloaded" } });
    await expect(off.runJob({ role: "media", components: ["browser"] })).rejects.toThrow(/Screen capture didn't install: Playwright's video recorder couldn't be downloaded/);
    expect(off.calls).toEqual([]);
  });

  it("never runs anything outside the catalog", async () => {
    const h = harness();
    await expect(h.runJob({ components: ["gpu", "davinci", "evil; rm -rf /"] })).rejects.toThrow(/Nothing to install/);
    expect(h.calls).toEqual([]);
  });

  it("treats already installed as done, and reports the ones that failed after trying the rest", async () => {
    const h = harness({ "Git.Git": 0x8a150061 - 0x1_0000_0000, "Anthropic.ClaudeCode": 1603 });
    await expect(h.runJob({ role: "claude", components: ["git", "claude-code"] })).rejects.toThrow(
      /Installed Git\.\nClaude Code didn't install: Downloading · Installer failed with exit code: 1603/,
    );
    expect(h.calls).toHaveLength(2);
    expect(h.refreshed()).toBe(1); // what did install still shows up
  });

  it("treats winget's already-installed codes as done however Node signs them, and its 'no newer version' words too", async () => {
    for (const code of [0x8a15002b, 0x8a15002b - 0x1_0000_0000, 0x8a150061]) {
      const h = harness({ "Gyan.FFmpeg": code });
      expect(await h.runJob({ role: "media", components: ["ffmpeg"] })).toEqual({ role: "media", installed: ["ffmpeg"] });
    }
    const words = harness(
      { "Gyan.FFmpeg": 0x8a150109 },
      "win32",
      { output: "Found an existing package already installed. Trying to upgrade the installed package...\nNo available upgrade found.\nNo newer package versions are available from the configured sources.\n" },
    );
    expect(await words.runJob({ role: "media", components: ["ffmpeg"] })).toEqual({ role: "media", installed: ["ffmpeg"] });
  });

  it("counts a component as installed when the computer finds it afterwards, whatever winget said", async () => {
    const h = harness({ "Gyan.FFmpeg": 1 }, "win32", { installedAfter: ["ffmpeg"] });
    expect(await h.runJob({ role: "media", components: ["ffmpeg"] })).toEqual({ role: "media", installed: ["ffmpeg"] });
  });

  it("only installs on Windows", async () => {
    const h = harness({}, "linux");
    await expect(h.runJob({ components: ["ffmpeg"] })).rejects.toThrow(/Windows only/);
    expect(h.calls).toEqual([]);
  });
});

describe("detectSetup", () => {
  /** A fake runner: `--version` works only for the given winget paths. */
  const wingetAt = (...paths: string[]): RunCommand => async (cmd, args) => ({ code: args[0] === "--version" && paths.includes(cmd) ? 0 : 1, output: "v1.12" });

  it("finds installed tools on PATH and a working winget on Windows", async () => {
    const bin = mkdtempSync(join(tmpdir(), "cc-setup-"));
    for (const name of ["ffmpeg.exe", "git.exe", "winget.exe"]) writeFileSync(join(bin, name), "");
    mkdirSync(join(bin, "Google", "Chrome", "Application"), { recursive: true });
    writeFileSync(join(bin, "Google", "Chrome", "Application", "chrome.exe"), "");
    const env = { PATH: bin, PATHEXT: ".EXE", ProgramFiles: bin, "ProgramFiles(x86)": join(bin, "none"), PROGRAMDATA: join(bin, "none") };
    const setup = await detectSetup({ ffmpegBin: "ffmpeg", claudeBin: "claude", capabilities: ["gpu"], env, platform: "win32", run: wingetAt(join(bin, "winget.exe")) });
    expect(setup).toEqual({ platform: "win32", installer: "winget", installed: ["ffmpeg", "browser", "gpu", "git"] });
  });

  it("finds winget's app execution alias, which isn't a file Node can see", async () => {
    const env = { PATH: "C:\\nowhere", PATHEXT: ".EXE", LOCALAPPDATA: "C:\\Users\\dave\\AppData\\Local" };
    const alias = join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe");
    expect(await findWinget(env, "win32", wingetAt(alias))).toBe(alias);
    expect(await findWinget(env, "win32", wingetAt("winget.exe"))).toBe("winget.exe");
    expect(await findWinget(env, "win32", wingetAt())).toBeNull();
    expect(await findWinget(env, "linux", wingetAt("winget.exe"))).toBeNull();
  });

  it("counts screen capture only when it works, and reports why it doesn't", async () => {
    const env = { PATH: "/nonexistent" };
    const off = await detectSetup({ ffmpegBin: "ffmpeg", claudeBin: "claude", capabilities: [], env, platform: "linux", capture: { ready: false, why: "no recorder" } });
    expect(off).toMatchObject({ installed: [], capture: { ready: false, why: "no recorder" } });
    const on = await detectSetup({ ffmpegBin: "ffmpeg", claudeBin: "claude", capabilities: [], env, platform: "linux", capture: { ready: true } });
    expect(on).toMatchObject({ installed: ["browser"], capture: { ready: true } });
  });

  it("has no installer off Windows", async () => {
    const setup = await detectSetup({ ffmpegBin: "ffmpeg", claudeBin: "claude", capabilities: [], env: { PATH: "/nonexistent" }, platform: "linux" });
    expect(setup).toMatchObject({ platform: "linux", installer: null });
  });
});

describe("PATH after installs (ffmpeg missing again after each app update)", () => {
  const saved = process.env.PATH;
  afterEach(() => {
    process.env.PATH = saved;
  });

  it("adds the registry's new directories to the PATH this process started with, without duplicates", () => {
    const links = "C:\\Users\\dave\\AppData\\Local\\Microsoft\\WinGet\\Links";
    const current = "C:\\Program Files\\Command Centre;C:\\Windows\\system32";
    const fresh = `c:\\windows\\System32\\;C:\\Windows;${links}`;
    expect(mergePath(current, fresh, "win32")).toBe(`C:\\Program Files\\Command Centre;C:\\Windows\\system32;C:\\Windows;${links}`);
    expect(mergePath(undefined, "/usr/bin:/bin", "linux")).toBe("/usr/bin:/bin");
    expect(mergePath("/usr/bin:/opt/x/", "/opt/x:/bin", "linux")).toBe("/usr/bin:/opt/x/:/bin");
  });

  it("finds ffmpeg that winget put on the user's PATH after the worker started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-links-"));
    writeFileSync(join(dir, "ffmpeg.exe"), "");
    process.env.PATH = "/nonexistent";
    const env = process.env;
    const before = await detectSetup({ ffmpegBin: "ffmpeg", claudeBin: "claude", capabilities: [], env, platform: "win32", run: async () => ({ code: 1, output: "" }) });
    expect(before.installed).not.toContain("ffmpeg");
    // The registry's PATH (machine;user), as `powershell` reads it.
    const run: RunCommand = async (cmd) => (cmd === "powershell.exe" ? { code: 0, output: `C:\\Windows;${dir}\r\n` } : { code: 1, output: "" });
    await refreshProcessPath("win32", run);
    expect(process.env.PATH!.split(";")).toEqual(["/nonexistent", "C:\\Windows", dir]);
    const after = await detectSetup({ ffmpegBin: "ffmpeg", claudeBin: "claude", capabilities: [], env: { ...process.env, PATH: dir }, platform: "win32", run: async () => ({ code: 1, output: "" }) });
    expect(after.installed).toContain("ffmpeg");
  });

  it("leaves PATH alone off Windows, or when the registry can't be read", async () => {
    process.env.PATH = "/usr/bin";
    await refreshProcessPath("linux", async () => ({ code: 0, output: "C:\\x" }));
    await refreshProcessPath("win32", async () => ({ code: 1, output: "" }));
    await refreshProcessPath("win32", async () => {
      throw new Error("no powershell");
    });
    expect(process.env.PATH).toBe("/usr/bin");
  });
});
