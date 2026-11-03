/**
 * Chat in real Chromium with the server mocked: a chat whose work was handed to another role
 * shows that role's approval inline, with a playable video preview and Approve. Skipped when no
 * Chromium is installed (set PW_CHROMIUM to point at one).
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { videoOf } from "../src/video";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

describe("videoOf", () => {
  it("finds a video in a proposal payload or a render result, and only http(s) ones", () => {
    expect(videoOf({ title: "x", video: { url: "https://cc.example/media/a.mp4", durationSec: 61.4, width: 1080, height: 1920 } })).toEqual({
      url: "https://cc.example/media/a.mp4",
      durationSec: 61.4,
      width: 1080,
      height: 1920,
    });
    expect(videoOf({ outputPath: "/tmp/a.mp4", url: "https://cc.example/media/b.mp4", width: 1920, height: 1080 })?.url).toBe("https://cc.example/media/b.mp4");
    expect(videoOf({ video: { url: "javascript:alert(1)" } })).toBeNull();
    expect(videoOf({ outputPath: "/tmp/a.mp4" })).toBeNull();
    expect(videoOf(null)).toBeNull();
  });
});

describe.skipIf(!existsSync(CHROMIUM))("Chat: approvals inline (Playwright)", () => {
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

  it("shows the handed-off role's approval, with its video, in the chat reply", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      (window as unknown as { WebSocket: unknown }).WebSocket = class {
        send() {}
        close() {}
      };
      localStorage.setItem("cc.connection", JSON.stringify({ baseUrl: "", token: "test-token" }));
    });
    const calls: string[] = [];
    const now = new Date().toISOString();
    const task = { id: "11111111-1111-4111-8111-111111111111", eventId: "e1", vertical: "personal", intent: "question", route: "agent", urgency: 0.3, status: "awaiting_approval", prompt: "x", role: "chief-of-staff", createdAt: now, updatedAt: now };
    const proposal = (id: string, status: string) => ({
      id,
      taskId: "22222222-2222-4222-8222-222222222222", // the Video Producer's handoff task, not the chat's own
      vertical: "3dpandme",
      actionType: "social.campaign",
      summary: `Post video "Spindle tram" (61s 1080x1920)`,
      payload: { title: "Spindle tram", posts: [], video: { url: `${base}/clip.mp4`, durationSec: 61, width: 1080, height: 1920 } },
      policy: "draft",
      status,
      result: null,
      createdAt: now,
      decidedAt: null,
    });
    // The clip stays loading: the player itself is what's checked (a broken file shows a note instead).
    await page.route(`${base}/clip.mp4`, () => {});
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api/, "");
      calls.push(`${route.request().method()} ${path}`);
      const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/verticals") return json([{ id: "personal", name: "Personal" }, { id: "3dpandme", name: "3dpandme" }]);
      if (path === "/stats") return json({ pendingApprovals: 1, costTodayUsd: 0 });
      if (path === "/social/accounts") return json([]);
      if (path === "/chat") return json({ event: { id: "e1" }, task }, 201);
      if (path === `/tasks/${task.id}/chain-proposals`) {
        return json({ taskIds: [task.id, "22222222-2222-4222-8222-222222222222"], proposals: [proposal("p2", "executed"), proposal("p1", "pending")] });
      }
      if (path === "/proposals/p1/approve") return json(proposal("p1", "executed"));
      return json({ error: `unmocked ${path}` }, 404);
    });

    await page.goto(`${base}/#/chat`);
    const box = page.getByPlaceholder("What needs doing?");
    await box.waitFor({ timeout: 20_000 });
    await box.fill("Post the spindle tram video");
    await box.press("Enter");

    const card = page.locator(".inline-proposals .card.proposal.is-pending");
    await card.waitFor({ timeout: 15_000 });
    expect(await page.locator(".inline-proposals").getByText("Waiting for your approval:").count()).toBe(1);
    // The video plays in place, portrait-sized, with its length and size.
    const video = card.locator(".video-preview.portrait video");
    expect(await video.getAttribute("src")).toBe(`${base}/clip.mp4`);
    expect(await video.getAttribute("controls")).not.toBeNull();
    expect(await card.locator("figcaption").textContent()).toContain("1:01 · 1080×1920");
    // The decided one is folded away.
    expect(await page.locator(".inline-proposals > details > summary").textContent()).toContain("1 action done or decided");

    await card.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => calls.includes("POST /proposals/p1/approve")).toBe(true);
    expect(errors).toEqual([]);
  }, 60_000);
});
