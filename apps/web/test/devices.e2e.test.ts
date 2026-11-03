/**
 * Devices page in real Chromium with the server mocked: each computer's roles with what's
 * installed and missing, and the one-click Install. Skipped when no Chromium is installed.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

describe.skipIf(!existsSync(CHROMIUM))("Devices page roles (Playwright)", () => {
  let vite: ViteDevServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    process.env.CC_SERVER_URL ??= "http://127.0.0.1:9";
    vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
    await vite.listen();
    base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it("shows what each computer has for each role, and installs what's missing with one click", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      (window as unknown as { WebSocket: unknown }).WebSocket = class {
        send() {}
        close() {}
      };
      localStorage.setItem("cc.connection", JSON.stringify({ baseUrl: "", token: "test-token" }));
    });
    const now = new Date().toISOString();
    const nodes = [
      {
        id: "studio",
        name: "Studio PC",
        capabilities: ["ffmpeg", "gpu"],
        setup: {
          platform: "win32",
          installer: "winget",
          installed: ["ffmpeg", "gpu", "git"],
          capture: { ready: false, why: "Playwright's video recorder couldn't be downloaded" },
          appVersion: "0.1.12",
        },
        online: true,
        lastSeen: now,
      },
      { id: "old", name: "Old Laptop", capabilities: ["ffmpeg"], online: false, lastSeen: now },
      {
        id: "edit",
        name: "Edit Bay",
        capabilities: ["ffmpeg", "browser", "claude-local"],
        setup: { platform: "win32", installer: "winget", installed: ["ffmpeg", "browser", "git", "claude-code"], appVersion: "0.1.13" },
        online: true,
        lastSeen: now,
      },
    ];
    const jobs: unknown[] = [];
    const installs: unknown[] = [];
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api/, "");
      const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/stats") return json({ pendingApprovals: 0, costTodayUsd: 0 });
      if (path === "/verticals") return json([]);
      if (path === "/nodes") return json(nodes);
      if (path === "/jobs") return json(jobs);
      if (path === "/desktop/devices") return json([]);
      if (path === "/desktop/installer") return json({ installer: { version: "0.1.13", filename: "setup.exe", size: 1, sha256: "x", commit: null, uploadedAt: now } });
      if (path === "/nodes/studio/setup" && route.request().method() === "POST") {
        installs.push(route.request().postDataJSON());
        const job = { id: "j1", kind: "setup.install", requires: [], payload: { role: "claude", components: ["claude-code"] }, status: "queued", nodeId: null, targetNodeId: "studio", progress: null, result: null, createdAt: now, updatedAt: now };
        jobs.push(job);
        return json(job, 201);
      }
      return json({ error: `unmocked ${path}` }, 404);
    });

    await page.goto(`${base}/#/devices`);
    const studio = page.locator(".device-row", { hasText: "Studio PC" });
    await studio.locator(".device-role").first().waitFor({ timeout: 20_000 });

    const media = studio.locator(".device-role", { hasText: "Media production" });
    expect(await media.locator(".device-role-item.installed").allTextContents()).toEqual([
      expect.stringContaining("ffmpeg"),
      expect.stringContaining("Graphics card"),
    ]);
    const capture = media.locator(".device-role-item", { hasText: "Screen capture" });
    expect(await capture.textContent()).toContain("Not installed");
    expect(await capture.locator(".device-role-reason").textContent()).toBe("Off: Playwright's video recorder couldn't be downloaded");
    expect(await media.locator(".device-role-item", { hasText: "DaVinci" }).getByRole("link").getAttribute("href")).toContain("blackmagicdesign.com");
    await media.getByRole("button", { name: "Install Screen capture" }).waitFor();

    expect(await studio.locator(".device-version").textContent()).toBe("Desktop app 0.1.12 · 0.1.13 available: choose Check for updates in its tray menu");
    expect(await page.locator(".device-row", { hasText: "Old Laptop" }).textContent()).toContain("Desktop app version unknown");

    const claude = studio.locator(".device-role", { hasText: "Local Claude Code" });
    expect(await claude.textContent()).toContain("1 missing");
    if (process.env.DEVICES_SHOT) await page.screenshot({ path: process.env.DEVICES_SHOT, fullPage: true });
    await claude.getByRole("button", { name: "Install Claude Code" }).click();
    await expect.poll(() => installs).toEqual([{ role: "claude" }]);
    // Install doesn't fold the box; clicking a role's header does, and again unfolds it.
    expect(await claude.getAttribute("open")).not.toBeNull();
    await media.locator("summary .device-role-title").click();
    expect(await media.getAttribute("open")).toBeNull();
    expect(await media.locator(".device-role-item").first().isVisible()).toBe(false);
    expect(await media.getByRole("button", { name: /^Install/ }).isVisible()).toBe(true);
    await media.locator("summary .device-role-title").click();
    expect(await media.getAttribute("open")).not.toBeNull();

    // An older app (no setup report) shows what its capabilities say, and how to get the button.
    const old = page.locator(".device-row", { hasText: "Old Laptop" });
    expect(await old.textContent()).toContain("Update the desktop app on this computer to install from here.");
    expect(await old.getByRole("button", { name: /^Install/ }).count()).toBe(0);
    // Roles with everything they need start folded.
    const edit = page.locator(".device-row", { hasText: "Edit Bay" });
    expect(await edit.locator(".device-role[open]").count()).toBe(0);
    expect(await edit.locator(".device-role-badge").allTextContents()).toEqual(["Ready", "Ready"]);
    expect(errors).toEqual([]);
  }, 60_000);
});
