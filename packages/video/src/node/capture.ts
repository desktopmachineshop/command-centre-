/// <reference lib="dom" />
import { readdirSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { type Brand, CAPTURE_VIEWPORT, type CaptureScene, type Format, type Step } from "../spec";

/**
 * The capture runner: plays a capture scene's scripted steps in Chromium and
 * records the viewport with Playwright's video recorder (WebM, ~25 fps).
 * Highlight and zoom are done in the page (an outline box, a CSS transform),
 * so the recording already shows them and the compositor only has to fit it.
 */

export interface CaptureOptions {
  /** Where recordings go; the clip is saved as `<scene id>.webm`. */
  dir: string;
  format: Format;
  brand: Pick<Brand, "colours">;
  /** Chromium to drive (e.g. /opt/pw-browsers/chromium or Chrome on Windows). */
  executablePath?: string;
  /** Use an existing browser instead of launching one (tests, batching). */
  browser?: Browser;
  /** Signed-in profiles by name: Playwright storage-state JSON files on this machine. */
  profiles?: Record<string, string>;
  signal?: AbortSignal;
  /** How long one step may wait for its element (default 10s). */
  stepTimeoutMs?: number;
  onStep?: (index: number, step: Step) => void;
}

export interface CaptureResult {
  file: string;
  path: string;
  bytes: number;
  /** Seconds of recording before the first page had loaded; the compositor skips them. */
  trimStartSec: number;
  /** Seconds of useful recording after the trim. */
  durationSec: number;
}

export class CaptureError extends Error {}

type PlaywrightModule = typeof import("playwright-core");
let loadPlaywright: () => Promise<PlaywrightModule> = () => import("playwright-core");

/**
 * Where playwright-core comes from. The desktop worker is a single executable that can't
 * import packages, so it loads the copy shipped beside it (see apps/worker/src/browser.ts).
 */
export function setPlaywrightLoader(load: () => Promise<PlaywrightModule>): void {
  loadPlaywright = load;
}

/** Launches Chromium through playwright-core, which is an optional dependency. */
export async function launchChromium(executablePath?: string): Promise<Browser> {
  let pw: PlaywrightModule;
  try {
    pw = await loadPlaywright();
  } catch {
    throw new CaptureError("playwright-core is not installed on this machine, so screen capture is unavailable");
  }
  return pw.chromium.launch({ executablePath, headless: true });
}

/**
 * Whether Playwright's own ffmpeg build (its video recorder) is downloaded, in
 * PLAYWRIGHT_BROWSERS_PATH or the default cache. Capture can't record without it.
 */
export function playwrightRecorderInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = [env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), ".cache", "ms-playwright"), join(env.LOCALAPPDATA ?? homedir(), "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright")];
  return dirs.some((dir) => {
    try {
      return !!dir && readdirSync(dir).some((name) => name.startsWith("ffmpeg"));
    } catch {
      return false;
    }
  });
}

const CURSOR_ID = "__cc_cursor";
const BOX_ID = "__cc_highlight";

/** Draws a pointer that the runner moves to each element before acting on it. */
function cursorScript(id: string) {
  const make = () => {
    if (document.getElementById(id)) return;
    const c = document.createElement("div");
    c.id = id;
    c.style.cssText =
      "position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;" +
      "transition:transform 500ms cubic-bezier(.4,0,.2,1);transform:translate(" + Math.round(innerWidth * 0.6) + "px," + Math.round(innerHeight * 0.7) + "px)";
    c.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.8 L20.5 15.8 Z" fill="#111" stroke="#fff" stroke-width="1.6"/></svg>';
    document.documentElement.appendChild(c);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make);
  else make();
}

async function moveCursor(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return;
  await page.evaluate(
    ({ id, x, y }) => {
      const c = document.getElementById(id);
      if (c) c.style.transform = `translate(${x}px,${y}px)`;
    },
    { id: CURSOR_ID, x: Math.round(box.x + box.width / 2 - 4), y: Math.round(box.y + box.height / 2 - 2) },
  );
  await page.waitForTimeout(550);
}

async function runStep(page: Page, step: Step, scene: CaptureScene, accent: string): Promise<void> {
  const settle = () => page.waitForTimeout(350);
  switch (step.action) {
    case "goto":
      await page.goto(step.url, { waitUntil: "load" });
      return;
    case "click":
      if (scene.cursor) await moveCursor(page, step.selector);
      await page.locator(step.selector).first().click();
      return settle();
    case "hover":
      if (scene.cursor) await moveCursor(page, step.selector);
      await page.locator(step.selector).first().hover();
      return settle();
    case "type":
      if (scene.cursor) await moveCursor(page, step.selector);
      await page.locator(step.selector).first().click();
      await page.locator(step.selector).first().pressSequentially(step.text, { delay: step.delayMs });
      return settle();
    case "press":
      await page.keyboard.press(step.key);
      return settle();
    case "select":
      if (scene.cursor) await moveCursor(page, step.selector);
      await page.locator(step.selector).first().selectOption(step.value);
      return settle();
    case "scroll":
      if (step.selector) await page.locator(step.selector).first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
      else await page.evaluate((y) => window.scrollTo({ top: y, behavior: "smooth" }), step.y ?? 0);
      await page.waitForTimeout(900);
      return;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
    case "highlight":
      await page
        .locator(step.selector)
        .first()
        .evaluate(
          (el, { id, colour }) => {
            const r = el.getBoundingClientRect();
            const box = document.createElement("div");
            box.id = id;
            box.style.cssText =
              `position:fixed;left:${r.left - 8}px;top:${r.top - 8}px;width:${r.width + 16}px;height:${r.height + 16}px;` +
              `border:4px solid ${colour};border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.35);z-index:2147483646;` +
              "pointer-events:none;opacity:0;transition:opacity 250ms";
            document.documentElement.appendChild(box);
            requestAnimationFrame(() => (box.style.opacity = "1"));
          },
          { id: BOX_ID, colour: accent },
        );
      await page.waitForTimeout(step.ms);
      await page.evaluate((id) => document.getElementById(id)?.remove(), BOX_ID);
      return;
    case "zoom":
      await page
        .locator(step.selector)
        .first()
        .evaluate(
          (el, scale) => {
            const r = el.getBoundingClientRect();
            const root = document.documentElement;
            root.style.transition = "transform 700ms cubic-bezier(.4,0,.2,1)";
            root.style.transformOrigin = `${r.left + r.width / 2 + scrollX}px ${r.top + r.height / 2 + scrollY}px`;
            root.style.transform = `scale(${scale})`;
          },
          step.scale,
        );
      await page.waitForTimeout(700 + step.ms);
      await page.evaluate(() => (document.documentElement.style.transform = "none"));
      await page.waitForTimeout(700);
      return;
  }
}

/** Records one capture scene. */
export async function captureScene(scene: CaptureScene, options: CaptureOptions): Promise<CaptureResult> {
  await mkdir(options.dir, { recursive: true });
  const viewport = scene.viewport ?? CAPTURE_VIEWPORT[options.format];
  let storageState: string | undefined;
  if (scene.authProfile) {
    storageState = options.profiles?.[scene.authProfile];
    if (!storageState) throw new CaptureError(`capture profile "${scene.authProfile}" is not configured on this worker`);
  }

  const ownBrowser = !options.browser;
  const browser = options.browser ?? (await launchChromium(options.executablePath));
  const rawDir = join(options.dir, `.raw-${scene.id}`);
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, recordVideo: { dir: rawDir, size: viewport }, storageState });
    if (scene.cursor) await context.addInitScript(cursorScript, CURSOR_ID);
    context.setDefaultTimeout(options.stepTimeoutMs ?? 10_000);
    const page = await context.newPage().catch(async (err: Error) => {
      await context.close().catch(() => {});
      // Playwright records video with its own ffmpeg build, separate from the system one.
      throw /Executable doesn't exist/i.test(err.message)
        ? new CaptureError("Playwright's video recorder is missing: run `npx playwright-core install ffmpeg` on this machine")
        : err;
    });
    const t0 = Date.now();
    const abort = () => void context.close().catch(() => {});
    options.signal?.addEventListener("abort", abort, { once: true });

    let trimStartSec = 0;
    try {
      for (const [i, step] of scene.steps.entries()) {
        if (options.signal?.aborted) throw new CaptureError("capture aborted");
        options.onStep?.(i, step);
        await runStep(page, step, scene, options.brand.colours.accent);
        if (i === 0) {
          await page.waitForTimeout(200);
          trimStartSec = (Date.now() - t0) / 1000;
        }
      }
      await page.waitForTimeout(600); // let the last action land on screen
    } catch (err) {
      await context.close().catch(() => {});
      throw err instanceof CaptureError ? err : new CaptureError(`capture of "${scene.id}" failed: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    const elapsed = (Date.now() - t0) / 1000;
    const video = page.video();
    await context.close(); // the recording is written on close
    if (!video) throw new CaptureError("Playwright did not record a video");
    const file = `${scene.id}.webm`;
    const path = join(options.dir, file);
    await rename(await video.path(), path);
    return { file, path, bytes: (await stat(path)).size, trimStartSec: round(trimStartSec), durationSec: round(elapsed - trimStartSec) };
  } finally {
    if (ownBrowser) await browser.close().catch(() => {});
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Records several capture scenes in one browser. */
export async function captureScenes(scenes: CaptureScene[], options: CaptureOptions): Promise<Record<string, CaptureResult>> {
  const browser = options.browser ?? (await launchChromium(options.executablePath));
  try {
    const out: Record<string, CaptureResult> = {};
    for (const scene of scenes) out[scene.id] = await captureScene(scene, { ...options, browser });
    return out;
  } finally {
    if (!options.browser) await browser.close().catch(() => {});
  }
}
