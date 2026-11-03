import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserCandidates, findBrowser, findPlaywrightDir, loadPlaywrightFrom, prepareCapture } from "../src/browser";

const tmp = () => mkdtempSync(join(tmpdir(), "cc-browser-"));

describe("finding a browser to capture with", () => {
  it("knows where Chrome and Edge live on Windows, preferring Chrome", () => {
    const list = browserCandidates({ ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\dave\\AppData\\Local" }, "win32");
    expect(list[0]).toBe(join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"));
    expect(list).toContain(join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"));
    expect(list.findIndex((p) => p.includes("chrome.exe"))).toBeLessThan(list.findIndex((p) => p.includes("msedge.exe")));
  });

  it("finds an installed browser on PATH, and the configured one wins", () => {
    const bin = tmp();
    writeFileSync(join(bin, "chromium"), "", { mode: 0o755 });
    const env = { PATH: bin };
    expect(findBrowser(null, env, "linux")).toBe(join(bin, "chromium"));
    writeFileSync(join(bin, "my-chrome"), "", { mode: 0o755 });
    expect(findBrowser("my-chrome", env, "linux")).toBe(join(bin, "my-chrome"));
    expect(findBrowser("missing-chrome", env, "linux")).toBeNull();
    expect(findBrowser(null, { PATH: tmp() }, "linux")).toBeNull();
  });
});

describe("finding playwright-core", () => {
  it("prefers CC_PLAYWRIGHT_DIR, then the folder beside the executable", () => {
    const install = tmp();
    const beside = join(install, "playwright-core");
    mkdirSync(beside);
    writeFileSync(join(beside, "package.json"), JSON.stringify({ name: "playwright-core" }));
    expect(findPlaywrightDir({}, join(install, "cc-worker.exe"), "/nowhere/x.js")).toBe(beside);

    const custom = tmp();
    writeFileSync(join(custom, "package.json"), JSON.stringify({ name: "playwright-core" }));
    expect(findPlaywrightDir({ CC_PLAYWRIGHT_DIR: custom }, join(install, "cc-worker.exe"), "/nowhere/x.js")).toBe(custom);

    // A folder of the right name that isn't playwright-core doesn't count.
    const other = tmp();
    mkdirSync(join(other, "playwright-core"));
    writeFileSync(join(other, "playwright-core", "package.json"), JSON.stringify({ name: "something-else" }));
    expect(findPlaywrightDir({}, join(other, "cc-worker.exe"), "/nowhere/x.js")).not.toBe(join(other, "playwright-core"));
  });

  it("falls back to the package next to the running script (development)", async () => {
    const dir = findPlaywrightDir({}, "/no/exe", join(process.cwd(), "src", "main.ts"));
    expect(dir).toMatch(/playwright-core$/);
    const pw = await loadPlaywrightFrom(dir!)();
    expect(typeof pw.chromium.launch).toBe("function");
  });
});

describe("getting capture ready", () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    let installed = false;
    return {
      calls,
      deps: {
        findBrowser: () => "/usr/bin/chromium",
        findPlaywrightDir: () => "/opt/cc/playwright-core",
        recorderInstalled: () => installed,
        installRecorder: async (dir: string) => {
          calls.push(`install ${dir}`);
          installed = true;
          return true;
        },
        usePlaywright: async (dir: string) => void calls.push(`use ${dir}`),
        ...over,
      },
    };
  };

  it("is ready with a browser, Playwright and its recorder, downloading the recorder once", async () => {
    const { calls, deps: d } = deps();
    expect(await prepareCapture(null, { deps: d })).toEqual({ chromiumBin: "/usr/bin/chromium", ready: true });
    expect(calls).toEqual(["use /opt/cc/playwright-core", "install /opt/cc/playwright-core"]);
    calls.length = 0;
    expect((await prepareCapture(null, { deps: d })).ready).toBe(true);
    expect(calls).toEqual(["use /opt/cc/playwright-core"]); // already downloaded
  });

  it("says why it's off: no browser, no Playwright, Playwright won't load, or the download failed", async () => {
    expect(await prepareCapture(null, { deps: deps({ findBrowser: () => null }).deps })).toMatchObject({ ready: false, why: expect.stringMatching(/no Chrome, Edge or Chromium/) });
    expect(await prepareCapture("C:\\chrome.exe", { deps: deps({ findBrowser: () => null }).deps })).toMatchObject({ ready: false, why: expect.stringMatching(/chromiumBin C:\\chrome.exe wasn't found/) });
    expect(await prepareCapture(null, { deps: deps({ findPlaywrightDir: () => null }).deps })).toMatchObject({ ready: false, why: expect.stringMatching(/update the desktop app/) });
    const broken = deps({ usePlaywright: async () => Promise.reject(new Error("Cannot find module './lib/coreBundle'")) }).deps;
    expect(await prepareCapture(null, { deps: broken })).toMatchObject({ ready: false, why: expect.stringMatching(/couldn't be loaded: Cannot find module/) });
    expect(await prepareCapture(null, { deps: deps({ installRecorder: async () => false }).deps })).toMatchObject({ ready: false, why: expect.stringMatching(/recorder couldn't be downloaded/) });
  });
});
