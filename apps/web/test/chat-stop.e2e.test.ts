/**
 * Stopping agents from the chat, in real Chromium with the server mocked: Stop on a working turn,
 * "Stop & edit" (the message and its files back in the box, then sent afresh), and Stop all in the
 * top bar. Skipped when no Chromium is installed.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { STOPPED_NOTE } from "@cc/core";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

describe.skipIf(!existsSync(CHROMIUM))("Chat: stopping the agent (Playwright)", () => {
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

  const at = new Date(Date.UTC(2026, 10, 3, 10, 0, 0)).toISOString();
  const taskWith = (id: string, status: string, note: string | null = null) => ({
    id,
    eventId: "e1",
    vertical: "personal",
    intent: "question",
    route: "agent",
    urgency: 0.3,
    status,
    note,
    prompt: "x",
    role: "chief-of-staff",
    createdAt: at,
    updatedAt: at,
  });

  async function setup(page: Page) {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).WebSocket = class {
        send() {}
        close() {}
      };
      localStorage.setItem("cc.connection", JSON.stringify({ baseUrl: "", token: "test-token" }));
    });
    const calls: { path: string; body: unknown }[] = [];
    let chats = 0;
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api/, "");
      const isJson = (req.headers()["content-type"] ?? "").includes("json");
      calls.push({ path, body: isJson && req.postData() ? JSON.parse(req.postData()!) : null });
      const json = (data: unknown, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/verticals") return json([{ id: "personal", name: "Personal" }]);
      if (path === "/stats") return json({ pendingApprovals: 0, costTodayUsd: 0, activeTasks: 2 });
      if (path === "/voice/config") return json({ stt: null, tts: null, maxUploadBytes: 0, maxSeconds: 60, language: "en-GB", calendar: false });
      if (path === "/chat/files") {
        return json({ id: "0".repeat(31) + "1", name: url.searchParams.get("name"), contentType: req.headers()["content-type"], size: 4 }, 201);
      }
      if (path === "/chat") return json({ event: { id: "e1" }, task: taskWith(`${++chats}1111111-1111-4111-8111-111111111111`, "running") }, 201);
      const stop = /^\/tasks\/([^/]+)\/stop$/.exec(path);
      if (stop) return json({ stopped: [taskWith(stop[1]!, "failed", STOPPED_NOTE)] });
      if (path === "/tasks/stop-all") return json({ stopped: [] });
      if (/\/chain-proposals$/.test(path)) return json({ taskIds: [], proposals: [] });
      return json({ error: `unmocked ${path}` }, 404);
    });
    return calls;
  }

  it("stops a turn, and Stop & edit puts the message and its file back to send again", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const calls = await setup(page);
    await page.goto(`${base}/#/chat`);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor({ timeout: 20_000 });

    // Stop all shows while agents are working.
    await page.getByRole("button", { name: "Stop all agents (2 working)" }).waitFor();

    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach files" }).click()]);
    await chooser.setFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) });
    await page.locator(".composer-files .file-chip.is-ready", { hasText: "photo.png" }).waitFor();
    await box.fill("what is in this photo of the mill");
    await box.press("Enter");
    const sent = page.locator(".bubble.me", { hasText: "what is in this photo of the mill" });
    await sent.waitFor();

    await sent.getByRole("button", { name: "Stop & edit" }).click();
    await expect.poll(() => box.inputValue()).toBe("what is in this photo of the mill");
    await page.locator(".composer-files .file-chip.is-ready", { hasText: "photo.png" }).waitFor();
    await page.getByText("Editing your stopped message").waitFor();
    expect(await page.locator(".bubble.me").count()).toBe(0); // the stopped turn is gone from the chat
    expect(calls.filter((c) => c.path === "/tasks/11111111-1111-4111-8111-111111111111/stop")).toHaveLength(1);
    if (process.env.TASK_SHOTS) await page.screenshot({ path: `${process.env.TASK_SHOTS}/chat-stop-edit.png` });

    // The corrected message starts the chat afresh (it was the task's first message), with the file.
    await box.fill("what is in this photo of the lathe");
    await box.press("Enter");
    await expect.poll(() => calls.filter((c) => c.path === "/chat").at(-1)?.body).toEqual({
      text: "what is in this photo of the lathe",
      files: ["0".repeat(31) + "1"],
    });
    await page.locator(".bubble.me", { hasText: "lathe" }).waitFor();
    expect(await page.getByText("Editing your stopped message").count()).toBe(0);

    // Plain Stop leaves the turn, marked stopped.
    await page.locator(".bubble.agent").getByRole("button", { name: "Stop the agent" }).click();
    await page.locator(".bubble.agent .status", { hasText: "stopped" }).waitFor();
    await page.getByText("Stopped. Send a message to carry on").waitFor();
    expect(errors).toEqual([]);
    await page.close();
  });

  it("Stop all asks first, then stops every agent", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const calls = await setup(page);
    await page.goto(`${base}/#/chat`);
    const button = page.getByRole("button", { name: "Stop all agents (2 working)" });
    await button.waitFor({ timeout: 20_000 });
    page.once("dialog", (d) => void d.dismiss());
    await button.click();
    expect(calls.some((c) => c.path === "/tasks/stop-all")).toBe(false);
    page.once("dialog", (d) => void d.accept());
    await button.click();
    await expect.poll(() => calls.some((c) => c.path === "/tasks/stop-all")).toBe(true);
    await page.close();
  });
});
