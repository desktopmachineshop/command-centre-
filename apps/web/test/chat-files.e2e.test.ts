/**
 * Files in the chat box, in real Chromium with the server mocked: the paperclip, pasting a
 * screenshot and dropping a file attach them (each uploads straight away), Send passes their
 * ids with the message, and the sent turn lists them. Skipped when no Chromium is installed.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askText } from "../src/format";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

describe("attached files in a task's prompt", () => {
  it("shows what Dave asked without the files' text", () => {
    expect(askText("check these prices\n\nDave attached a file to this message. The contents...\n- prices.csv")).toBe("check these prices");
  });
});

describe.skipIf(!existsSync(CHROMIUM))("Chat: attaching, pasting and dropping files (Playwright)", () => {
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
  const at = new Date(Date.UTC(2026, 10, 3, 10, 0, 0)).toISOString();

  async function setup(page: Page, opts: { failUpload?: string } = {}) {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).WebSocket = class {
        send() {}
        close() {}
      };
      localStorage.setItem("cc.connection", JSON.stringify({ baseUrl: "", token: "test-token" }));
    });
    const calls: { path: string; query: string; body: unknown; type: string | null }[] = [];
    let n = 0;
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api/, "");
      const isJson = (req.headers()["content-type"] ?? "").includes("json");
      calls.push({ path, query: url.search, body: isJson && req.postData() ? JSON.parse(req.postData()!) : null, type: req.headers()["content-type"] ?? null });
      const json = (data: unknown, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
      const task = { id: TASK, eventId: "e1", vertical: "personal", intent: "question", route: "agent", urgency: 0.3, status: "queued", prompt: "x", role: "chief-of-staff", createdAt: at, updatedAt: at };
      if (path === "/verticals") return json([{ id: "personal", name: "Personal" }]);
      if (path === "/stats") return json({ pendingApprovals: 0, costTodayUsd: 0 });
      if (path === "/voice/config") return json({ stt: null, tts: null, maxUploadBytes: 0, maxSeconds: 60, language: "en-GB", calendar: false });
      if (path === "/chat/files") {
        const name = url.searchParams.get("name")!;
        if (name === opts.failUpload) return json({ error: "file is larger than 25 MB" }, 413);
        const size = req.postDataBuffer()?.length ?? 0;
        return json({ id: `${String(++n).padStart(32, "0")}`, name, contentType: req.headers()["content-type"], size }, 201);
      }
      if (path === "/chat") return json({ event: { id: "e1" }, task }, 201);
      if (path === `/tasks/${TASK}/chain-proposals`) return json({ taskIds: [TASK], proposals: [] });
      if (path === `/tasks/${TASK}`) return json({ task, event: null, proposals: [], runs: [] });
      return json({ error: `unmocked ${path}` }, 404);
    });
    return calls;
  }

  it("attaches with the paperclip, a paste and a drop, then sends the files with the message", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const calls = await setup(page);
    await page.goto(`${base}/#/chat`);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor({ timeout: 20_000 });

    // The paperclip opens a file picker.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach files" }).click()]);
    await chooser.setFiles({ name: "quote.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") });
    await page.locator(".composer-files .file-chip.is-ready", { hasText: "quote.pdf" }).waitFor();

    // A pasted screenshot (arrives as image.png) gets a readable name.
    await box.focus();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
      document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.locator(".composer-files .file-chip", { hasText: /^pasted-.*\.png/ }).waitFor();

    // Dropped on the box.
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["part,price\n"], "prices.csv", { type: "text/csv" }));
      document.querySelector("form.composer")!.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await page.locator(".composer-files .file-chip", { hasText: "prices.csv" }).waitFor();

    expect(calls.filter((c) => c.path === "/chat/files")).toHaveLength(3);
    expect(calls.find((c) => c.path === "/chat/files")).toMatchObject({ query: "?name=quote.pdf", type: "application/pdf" });

    // One removed before sending.
    await page.getByRole("button", { name: "Remove prices.csv" }).click();
    await box.fill("what do you make of these?");
    if (process.env.TASK_SHOTS) await page.screenshot({ path: `${process.env.TASK_SHOTS}/chat-files-composer.png` });
    await box.press("Enter");

    await expect.poll(() => calls.find((c) => c.path === "/chat")?.body).toMatchObject({
      text: "what do you make of these?",
      files: ["00000000000000000000000000000001", "00000000000000000000000000000002"],
    });
    const sent = page.locator(".bubble.me", { hasText: "what do you make of these?" });
    await sent.locator(".file-chip", { hasText: "quote.pdf" }).waitFor();
    expect(await sent.locator(".file-chip").count()).toBe(2);
    expect(await page.locator(".composer-files").count()).toBe(0); // the box is clear for the next message
    if (process.env.TASK_SHOTS) await page.screenshot({ path: `${process.env.TASK_SHOTS}/chat-files-sent.png` });

    // It survives a reload, like the rest of the chat.
    await page.reload();
    await page.locator(".bubble.me .file-chip", { hasText: "quote.pdf" }).waitFor({ timeout: 20_000 });
    expect(errors).toEqual([]);
  }, 90_000);

  it("sends files without text, and holds a send while a file failed to upload", async () => {
    const page = await browser.newPage();
    const calls = await setup(page, { failUpload: "huge.mov" });
    await page.goto(`${base}/#/chat`);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor({ timeout: 20_000 });

    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach files" }).click()]);
    await chooser.setFiles([
      { name: "huge.mov", mimeType: "video/quicktime", buffer: Buffer.from("x") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
    ]);
    await page.locator(".file-chip.is-failed", { hasText: "huge.mov" }).waitFor();
    await page.locator(".file-chip.is-ready", { hasText: "notes.txt" }).waitFor();
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Remove the files that didn't upload").waitFor();
    expect(calls.some((c) => c.path === "/chat")).toBe(false);

    await page.getByRole("button", { name: "Remove huge.mov" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => calls.find((c) => c.path === "/chat")?.body).toMatchObject({ text: "Have a look at the attached file.", files: [expect.any(String)] });
  }, 60_000);
});
