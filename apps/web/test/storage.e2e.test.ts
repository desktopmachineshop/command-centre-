/**
 * Storage page in real Chromium with the server mocked: the volume meter, usage by folder,
 * the file list with a video preview, and delete. Skipped when no Chromium is installed.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytes } from "../src/pages/Storage";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("bytes", () => {
  it("reads like a person would say it", () => {
    expect(bytes(4.5 * GB)).toBe("4.5 GB");
    expect(bytes(340 * MB)).toBe("340 MB");
    expect(bytes(12 * 1024)).toBe("12 KB");
    expect(bytes(80)).toBe("80 B");
  });
});

describe.skipIf(!existsSync(CHROMIUM))("Storage page (Playwright)", () => {
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

  it("shows the disk, the folders and the files, and deletes one", async () => {
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
    let files = [
      { id: "a".repeat(32) + ".mp4", name: "spindle-tram/final.mp4", size: 220 * MB, contentType: "video/mp4", folder: "renders", backend: "local", createdAt: now, url: `${base}/media/a.mp4` },
      { id: "b".repeat(32) + ".webp", name: "er11-collets.webp", size: 300 * 1024, contentType: "image/webp", folder: "media", backend: "local", createdAt: now, url: `${base}/media/b.webp` },
      { id: "c".repeat(32) + ".pdf", name: "arc-euro-pricelist.pdf", size: 2 * MB, contentType: "application/pdf", folder: "attachments", backend: "local", createdAt: now, url: null },
    ];
    const deletes: string[] = [];
    await page.route(`${base}/media/**`, () => {}); // previews stay loading: the player is what's checked
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api/, "");
      const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/stats") return json({ pendingApprovals: 0, costTodayUsd: 0 });
      if (path === "/verticals") return json([]);
      if (path === "/storage") {
        return json({
          backend: "local",
          byFolder: [
            { folder: "renders", backend: "local", files: 1, bytes: 220 * MB },
            { folder: "media", backend: "local", files: 1, bytes: 300 * 1024 },
            { folder: "attachments", backend: "local", files: 1, bytes: 2 * MB },
          ],
          totalBytes: 222 * MB,
          files,
          volume: { free: 0.9 * GB, total: 5 * GB, minFreeBytes: 500 * MB, renderRetentionDays: 30 },
          drive: null,
          cache: null,
        });
      }
      if (route.request().method() === "DELETE" && path.startsWith("/storage/")) {
        const id = decodeURIComponent(path.slice("/storage/".length));
        deletes.push(id);
        files = files.filter((f) => f.id !== id);
        return json({ ok: true });
      }
      return json({ error: `unmocked ${path}` }, 404);
    });

    await page.goto(`${base}/#/storage`);
    await page.getByRole("heading", { name: "Storage" }).first().waitFor({ timeout: 20_000 });
    const meter = page.getByRole("meter", { name: "Server disk used" });
    await meter.waitFor();
    expect(await meter.getAttribute("aria-valuenow")).toBe("82");
    expect(await page.locator(".card", { hasText: "Server disk" }).textContent()).toContain("4.1 GB of 5.0 GB used · 922 MB free · nearly full");
    expect(await page.getByText("Video renders older than 30 days are deleted each night").count()).toBe(1);
    expect(await page.locator(".storage-folders li").count()).toBe(3);

    const video = page.locator(".storage-files li", { hasText: "spindle-tram/final.mp4" });
    await video.getByRole("button", { name: "Preview" }).click();
    expect(await video.locator("video").getAttribute("controls")).not.toBeNull();
    await page.screenshot({ path: process.env.STORAGE_SHOT ?? "/dev/null", fullPage: true });

    // A file without a public URL can't be previewed or opened, only deleted.
    const pdf = page.locator(".storage-files li", { hasText: "arc-euro-pricelist.pdf" });
    expect(await pdf.getByRole("button", { name: "Preview" }).count()).toBe(0);
    page.once("dialog", (d) => void d.accept());
    await pdf.getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => page.locator(".storage-files li").count()).toBe(2);
    expect(deletes).toEqual(["c".repeat(32) + ".pdf"]);
    expect(errors).toEqual([]);
  }, 60_000);
});
