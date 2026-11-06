/**
 * Task page in real Chromium with the server mocked: proposed actions in their own column (wide)
 * or tab (narrow), the conversation ending in the reply box, and failures with a copyable error
 * report. Skipped when no Chromium is installed (set PW_CHROMIUM to point at one).
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page, type Route } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorReport } from "../src/copy";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const SHOTS = process.env.TASK_SHOTS; // a folder for screenshots, when set

describe("errorReport", () => {
  it("lists what failed, its ids and the full error, leaving out empty facts", () => {
    const text = errorReport("Run failed", "spawn claude ENOENT\n    at ChildProcess", [["Task", "t1"], ["Role", null], ["Cost", "$0.02"]], new Date("2026-11-03T15:00:00Z"));
    expect(text).toContain("Command Centre error: Run failed\n\nTask: t1\nCost: $0.02\nSeen: 2026-11-03T15:00:00.000Z\nApp build: ");
    expect(text).not.toContain("Role:");
    expect(text.endsWith("Error:\nspawn claude ENOENT\n    at ChildProcess")).toBe(true);
  });
});

describe.skipIf(!existsSync(CHROMIUM))("Task page (Playwright)", () => {
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

  const TASK = "11111111-1111-4111-8111-111111111111";
  const now = new Date().toISOString();

  async function open(page: Page, extra?: (path: string, route: Route) => Promise<void> | undefined) {
    await page.addInitScript(() => {
      (window as unknown as { WebSocket: unknown }).WebSocket = class {
        send() {}
        close() {}
      };
      localStorage.setItem("cc.connection", JSON.stringify({ baseUrl: "", token: "test-token" }));
    });
    const long = Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: checked the order and the courier.`).join("\n\n");
    const task = { id: TASK, eventId: "e1", vertical: "dms", intent: "order-status", route: "agent", urgency: 0.5, status: "failed", prompt: "Where is order 1042?", role: "customer-support", note: "Run failed: spawn claude ENOENT", createdAt: now, updatedAt: now };
    const run = (id: string, text: string, error: string | null) => ({ id, taskId: TASK, runner: "claude-code", status: error ? "failed" : "succeeded", result: text, error, costUsd: 0.02, sessionId: "s", startedAt: now, finishedAt: now, messages: [{ type: "text", text }] });
    const proposal = (id: string, status: string, summary: string, result: unknown = null) => ({
      id, taskId: TASK, vertical: "dms", actionType: "email.reply", summary, payload: { to: "jane@example.com", subject: "Order 1042", body: "Hi Jane" }, policy: "draft", status, result, createdAt: now, decidedAt: status === "pending" ? null : now,
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      const json = (data: unknown, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
      const handled = extra?.(path, route);
      if (handled) return handled;
      if (path === "/stats") return json({ pendingApprovals: 1, costTodayUsd: 0 });
      if (path === "/verticals") return json([{ id: "dms", name: "Desktop Machine Shop" }]);
      if (path === "/social/accounts") return json([]);
      if (path === `/tasks/${TASK}`) {
        return json({
          task,
          event: null,
          runs: [run("r1", long, null), run("r2", "Trying again…", "spawn claude ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)")],
          proposals: [proposal("p1", "failed", "Reply to Jane about order 1042", { ok: false, error: "SMTP 535 authentication failed" }), proposal("p2", "pending", "Post a note on S01042")],
        });
      }
      return json({ error: `unmocked ${path}` }, 404);
    });
    await page.goto(`${base}/#/task/${TASK}`);
    await page.locator(".run-card").first().waitFor({ timeout: 20_000 });
  }

  it("each reply has a play button that reads it again with the server's voice", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const spoken: string[] = [];
    await open(page, (path, route) => {
      if (path === "/voice/config") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ stt: null, tts: { provider: "elevenlabs", model: "m", voice: "v" }, local: null, maxUploadBytes: 1, maxSeconds: 1, language: "en-GB", calendar: false }) });
      }
      if (path === "/voice/speak") {
        spoken.push((route.request().postDataJSON() as { text: string }).text);
        return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "no audio in this test" }) });
      }
      return undefined;
    });
    const buttons = page.getByRole("button", { name: "Play this reply" });
    await expect.poll(() => buttons.count()).toBe(2);
    await buttons.last().click();
    // The speaker first looks for the device's own voices (up to a second or two in headless Chromium).
    await expect.poll(() => spoken.join(" "), { timeout: 10_000 }).toContain("Trying again");
    expect(errors).toEqual([]);
  }, 60_000);

  it("wide: actions in a column on the right that stays in view at the bottom", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await open(page);
    const aside = page.getByRole("complementary", { name: "Proposed actions" });
    expect(await aside.isVisible()).toBe(true);
    expect(await page.locator(".task-tabs").isVisible()).toBe(false);
    // Waiting ones first.
    expect(await aside.locator(".card.proposal .title").first().textContent()).toBe("Post a note on S01042");
    // Scrolled to the latest answer at the bottom, the column is still on screen.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const box = await aside.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeLessThan(900);
    const main = await page.locator(".task-main").boundingBox();
    expect(box!.x).toBeGreaterThan(main!.x + main!.width - 1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/task-wide.png` });
    expect(errors).toEqual([]);
  }, 60_000);

  it("narrow: Conversation and Actions tabs, with the count waiting", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await open(page);
    const tabs = page.getByRole("tablist", { name: "Task view" });
    expect(await tabs.isVisible()).toBe(true);
    const actionsTab = tabs.getByRole("tab", { name: /Actions/ });
    expect(await actionsTab.textContent()).toBe("Actions1");
    expect(await page.getByRole("complementary", { name: "Proposed actions" }).isVisible()).toBe(false);
    // The tabs stay at the top while reading the bottom of the conversation.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect((await tabs.boundingBox())!.y).toBeLessThan(150);
    await actionsTab.click();
    expect(await page.getByRole("complementary", { name: "Proposed actions" }).isVisible()).toBe(true);
    expect(await page.locator(".task-main").isVisible()).toBe(false);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/task-narrow-actions.png` });
    await tabs.getByRole("tab", { name: "Conversation" }).click();
    expect(await page.locator(".task-main").isVisible()).toBe(true);
  }, 60_000);

  it("failures carry a copyable error report", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    const page = await context.newPage();
    await open(page);
    const runError = page.locator(".run-card .error-report");
    expect(await runError.textContent()).toContain("Run failed: spawn claude ENOENT");
    await runError.getByRole("button", { name: /Copy error report: Run failed/ }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("Command Centre error: Run failed");
    expect(copied).toContain(`Task: ${TASK}`);
    expect(copied).toContain("Run: r2");
    expect(copied).toContain("at ChildProcess._handle.onexit");
    expect(await runError.getByRole("button", { name: /Copy error/ }).textContent()).toContain("Copied");

    // The failed approval, in the actions column.
    const failed = page.getByRole("complementary", { name: "Proposed actions" }).locator(".error-report");
    expect(await failed.textContent()).toContain("email.reply failed: SMTP 535 authentication failed");
    await failed.getByRole("button", { name: /Copy error/ }).click();
    const copied2 = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied2).toContain("Approval: p1");
    expect(copied2).toContain("Error:\nSMTP 535 authentication failed");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/task-errors.png`, fullPage: true });
    await context.close();
  }, 60_000);
});
