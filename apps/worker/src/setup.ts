import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Capability, type NodeSetup, SETUP_COMPONENTS, type SetupComponentId, wingetPackages } from "@cc/core";
import { z } from "zod";
import { findBrowser } from "./browser";
import { davinciPaths, which } from "./capabilities";
import { defineHandler, JobError } from "./handlers/registry";

/**
 * Device roles on this computer (see packages/core/src/setup.ts): what's installed, and the
 * `setup.install` job behind the Devices page's Install button.
 */

export interface SetupProbe {
  claudeBin: string;
  ffmpegBin: string;
  chromiumBin?: string | null;
  /** Already detected, so the graphics card isn't probed twice. */
  capabilities: Capability[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Screen capture as prepareCapture found it; `browser` counts as installed only when it's ready. */
  capture?: { ready: boolean; why?: string };
  /** The desktop app's version, reported with the setup. */
  appVersion?: string | null;
  /** The desktop app runs this worker and installs updates when it asks (see WorkerClient onUpdate). */
  remoteUpdate?: boolean;
  /** Runs `winget --version` to see that it works; see findWinget. */
  run?: RunCommand;
}

/**
 * winget's path on Windows, or null. It's an app execution alias in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`: a zero-byte link Windows runs fine but Node's
 * existsSync/stat can't see, so it is found by running `winget --version`, which also proves it works.
 */
export async function findWinget(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, run: RunCommand = runCommand): Promise<string | null> {
  if (platform !== "win32") return null;
  const candidates = [
    which("winget", env, platform),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe") : null,
    "winget.exe",
  ].filter((c, i, all): c is string => !!c && all.indexOf(c) === i);
  for (const candidate of candidates) {
    const signal = AbortSignal.timeout(20_000);
    const result = await run(candidate, ["--version"], signal).catch(() => null);
    if (result?.code === 0) return candidate;
  }
  return null;
}

/** What this computer has, and whether it can install more (winget on Windows). */
export async function detectSetup(options: SetupProbe): Promise<NodeSetup> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const has: Record<SetupComponentId, boolean> = {
    ffmpeg: which(options.ffmpegBin, env, platform) !== null,
    browser: options.capture ? options.capture.ready : findBrowser(options.chromiumBin, env, platform) !== null,
    gpu: options.capabilities.includes("gpu"),
    davinci: options.capabilities.includes("davinci") || davinciPaths(platform, env).some((p) => existsSync(p)),
    git: which("git", env, platform) !== null,
    "claude-code": which(options.claudeBin, env, platform) !== null,
  };
  return {
    platform,
    installer: (await findWinget(env, platform, options.run)) ? "winget" : null,
    installed: (Object.keys(has) as SetupComponentId[]).filter((id) => has[id]),
    ...(options.capture ? { capture: { ready: options.capture.ready, ...(options.capture.why ? { why: options.capture.why.slice(0, 300) } : {}) } } : {}),
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    ...(options.remoteUpdate ? { remoteUpdate: true } : {}),
  };
}

/** Runs a command without a shell. Resolves to its exit code and output; rejects only if it can't start. */
export type RunCommand = (cmd: string, args: string[], signal: AbortSignal) => Promise<{ code: number; output: string }>;

export const runCommand: RunCommand = (cmd, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 }, (err, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      if (!err) return resolve({ code: 0, output });
      const code = (err as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ code, output });
      reject(err);
    });
  });

/** winget exit codes that mean "it's already there": treated as success. */
const ALREADY_INSTALLED = new Set([
  0x8a15002b - 0x1_0000_0000, // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE
  0x8a150061 - 0x1_0000_0000, // APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED
]);

export function wingetArgs(packageId: string): string[] {
  return [
    "install",
    "--id",
    packageId,
    "--exact",
    "--source",
    "winget",
    "--silent",
    "--accept-package-agreements",
    "--accept-source-agreements",
  ];
}

/**
 * Windows: PATH as a fresh login would see it (machine + user), so programs just installed are
 * found without restarting the app. The worker's own PATH was fixed when it started.
 */
export async function refreshWindowsPath(run: RunCommand = runCommand, signal = new AbortController().signal): Promise<string | null> {
  const script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], signal).catch(() => null);
  const path = result?.code === 0 ? result.output.trim() : "";
  return path ? path : null;
}

export interface SetupHandlerOptions {
  platform?: NodeJS.Platform;
  /** winget's path; defaults to findWinget. */
  winget?: () => Promise<string | null> | string | null;
  run?: RunCommand;
  /** Whether a browser is already there: then `browser` needs no Chrome, only capture set up again. */
  hasBrowser?: () => boolean;
  /** Updates this process's PATH after installing (Windows: from the registry). */
  refreshPath?: () => Promise<void>;
}

const Payload = z.object({ role: z.string().max(40).optional(), components: z.array(z.string().max(40)).min(1).max(20) });

export interface InstallOutcome {
  component: SetupComponentId;
  label: string;
  ok: boolean;
  /** Last lines of winget's output when it failed. */
  error?: string;
}

/**
 * `setup.install`: installs components from the catalog with winget, one after another, then
 * re-detects what this computer has and tells the server (ctx.refresh). Only catalog components
 * that install with winget are run; anything else in the payload is ignored.
 */
export function setupHandler(options: SetupHandlerOptions = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const refreshPath =
    options.refreshPath ??
    (async () => {
      if (platform !== "win32") return;
      const path = await refreshWindowsPath(run);
      if (path) process.env.PATH = path;
    });
  return defineHandler({
    kind: "setup.install",
    payload: Payload,
    async run(payload, ctx) {
      if (platform !== "win32") throw new JobError("Installing from the Devices page works on Windows only. Install the software on this computer yourself.");
      const winget = await (options.winget ?? (() => findWinget(process.env, platform, run)))();
      if (!winget) throw new JobError("winget isn't on this computer. Install App Installer from the Microsoft Store, then try again.");
      const packages = wingetPackages(payload.components);
      if (packages.length === 0) throw new JobError("Nothing to install: none of those can be installed from here.");

      const results: InstallOutcome[] = [];
      for (const [i, pkg] of packages.entries()) {
        if (ctx.signal.aborted) break;
        const label = SETUP_COMPONENTS[pkg.component].label;
        if (pkg.component === "browser" && (options.hasBrowser ?? (() => findBrowser(null) !== null))()) {
          // Chrome or Edge is there: capture is set up again below (ctx.refresh), nothing to install.
          results.push({ component: pkg.component, label, ok: true });
          continue;
        }
        ctx.progress(i / packages.length, `Installing ${label}`);
        try {
          const { code, output } = await run(winget, wingetArgs(pkg.id), ctx.signal);
          const ok = code === 0 || ALREADY_INSTALLED.has(code);
          results.push(ok ? { component: pkg.component, label, ok } : { component: pkg.component, label, ok, error: tail(output) || `winget exited with ${code}` });
        } catch (err) {
          results.push({ component: pkg.component, label, ok: false, error: (err as Error).message });
        }
      }
      ctx.progress(1, "Checking what's installed");
      await refreshPath().catch(() => {});
      const now = await ctx.refresh?.().catch(() => undefined);
      // Chrome or Edge is there but capture still isn't: say why (usually the recorder download).
      const capture = results.find((r) => r.component === "browser" && r.ok);
      if (capture && now?.setup?.capture && !now.setup.capture.ready) {
        capture.ok = false;
        capture.error = now.setup.capture.why ?? "it still isn't ready";
      }

      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        const done = results.filter((r) => r.ok).map((r) => r.label);
        throw new JobError(
          [
            done.length ? `Installed ${done.join(", ")}.` : null,
            ...failed.map((f) => `${f.label} didn't install: ${f.error}`),
            "If Windows asked for permission on the computer, allow it and try again.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      return { role: payload.role ?? null, installed: results.map((r) => r.component) };
    },
  });
}

/** The last few non-empty lines of a command's output (winget prints progress bars before). */
function tail(output: string, lines = 4): string {
  return output
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !/[█▒]/.test(l) && !/^[-\\|/ ]+$/.test(l))
    .slice(-lines)
    .join(" · ")
    .slice(0, 500);
}
