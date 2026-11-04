/**
 * Briefing view and notification centre in real Chromium with the server mocked: a notification's
 * media plays in place (video) or shows (image), with thumbnails in the lists. Skipped when no Chromium is installed.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

describe.skipIf(!existsSync(CHROMIUM))("Briefing media (Playwright)", () => {
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

  it("plays a notification's video and shows its image, with thumbnails in the lists", async () => {
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
    const video = `${base}/media/${"a".repeat(32)}.mp4`;
    const image = `${base}/media/${"b".repeat(32)}.png`;
    const note = (id: string, title: string, media: unknown[]) => ({
      id,
      category: "briefing",
      priority: "normal",
      vertical: null,
      title,
      body: `35s 1080x1920: ${video}`,
      url: `/briefing/${id}`,
      tag: null,
      actions: [],
      media,
      data: {},
      status: "inapp",
      createdAt: now,
      pushedAt: null,
      readAt: null,
    });
    const one = note("11111111-1111-4111-8111-111111111111", "Video ready: Milo V2 kit", [
      { url: video, type: "video", alt: "Milo V2 kit", durationSec: 35, width: 1080, height: 1920 },
      { url: image, type: "image", alt: "Kit photo" },
    ]);
    const other = note("22222222-2222-4222-8222-222222222222", "Video ready: older", [{ url: image, type: "image" }]);
    await page.route(`${base}/media/**`, () => {}); // media stays loading: the elements are what's checked
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/stats") return json({ pendingApprovals: 0, costTodayUsd: 0 });
      if (path === "/verticals") return json([]);
      if (path === `/notifications/${one.id}`) return json(one);
      if (path === "/notifications") return json({ items: [one, other], unread: 2, unreadByCategory: { briefing: 2 } });
      if (path === "/notifications/unread-count") return json({ unread: 2 });
      return json({ error: `unmocked ${path}` }, 404);
    });

    await page.goto(`${base}/#/briefing/${one.id}`);
    await page.getByRole("heading", { name: "Video ready: Milo V2 kit" }).waitFor({ timeout: 20_000 });
    const player = page.locator("article .notification-media video");
    expect(await player.getAttribute("src")).toBe(video);
    expect(await player.getAttribute("controls")).not.toBeNull();
    expect(await page.locator("article .video-preview figcaption").textContent()).toContain("0:35 · 1080×1920");
    expect(await page.locator("article .image-preview img").getAttribute("src")).toBe(image);
    // The other briefing in "Recent briefings" shows a thumbnail.
    expect(await page.locator(".list .thumb img").getAttribute("src")).toBe(image);
    if (process.env.BRIEFING_SHOT) await page.screenshot({ path: process.env.BRIEFING_SHOT, fullPage: true });

    await page.goto(`${base}/#/notifications`);
    await page.getByRole("heading", { name: "Notifications" }).waitFor();
    expect(await page.locator(".notification").first().locator(".thumb video").getAttribute("src")).toBe(video);
    expect(errors).toEqual([]);
  }, 60_000);
});
