/**
 * Chat in real Chromium with the server mocked: the conversation survives leaving the page and
 * reloading (until "New chat" or an hour idle), and the mic by Send dictates into the box.
 * Skipped when no Chromium is installed (set PW_CHROMIUM to point at one).
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messagesByTurn } from "../src/chat-store";
import { joinDictation } from "../src/voice/dictation";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

describe("chat store and dictation helpers", () => {
  const msg = (text: string) => ({ type: "text", text }) as never;

  it("gives each turn the runs that started after it", () => {
    const turns = [{ at: "2026-11-03T10:00:00Z" }, { at: "2026-11-03T10:05:00Z" }];
    const runs = [
      { startedAt: "2026-11-03T10:06:00Z", messages: [msg("second answer")] },
      { startedAt: "2026-11-03T10:00:01Z", messages: [msg("first answer")] },
      { startedAt: "2026-11-03T10:03:00Z", messages: [msg("report back on the first")] },
    ];
    expect(messagesByTurn(turns, runs)).toEqual([[msg("first answer"), msg("report back on the first")], [msg("second answer")]]);
    expect(messagesByTurn([], runs)).toEqual([]);
  });

  it("adds dictated words after what was typed", () => {
    expect(joinDictation("", " draft a reply ")).toBe("draft a reply");
    expect(joinDictation("dms:", "where is 1042")).toBe("dms: where is 1042");
    expect(joinDictation("dms: ", "where is 1042")).toBe("dms: where is 1042");
    expect(joinDictation("keep this", "  ")).toBe("keep this");
  });
});

describe.skipIf(!existsSync(CHROMIUM))("Chat: a lasting conversation and dictation (Playwright)", () => {
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
  const at = (s: number) => new Date(Date.UTC(2026, 10, 3, 10, 0, s)).toISOString();

  async function setup(page: Page, voiceStt: boolean) {
    await page.addInitScript((stt) => {
      const w = window as unknown as Record<string, unknown> & { __rec?: { onresult: (e: unknown) => void; onend: () => void } };
      w.WebSocket = class {
        send() {}
        close() {}
      };
      localStorage.setItem("cc.connection", JSON.stringify({ baseUrl: "", token: "test-token" }));
      // A fake recognition engine the test speaks through (window.__say).
      if (stt) {
        w.SpeechRecognition = class {
          lang = "";
          continuous = false;
          interimResults = false;
          maxAlternatives = 1;
          onresult: ((e: unknown) => void) | null = null;
          onend: (() => void) | null = null;
          onerror: ((e: unknown) => void) | null = null;
          onspeechstart: (() => void) | null = null;
          start() {
            w.__rec = this as never;
          }
          stop() {
            setTimeout(() => this.onend?.(), 0);
          }
          abort() {}
        };
        w.__say = (text: string) => {
          const result = Object.assign([{ transcript: text }], { isFinal: true });
          w.__rec?.onresult({ resultIndex: 0, results: [result] });
        };
      } else {
        // A device that can't listen: no recognition engine at all.
        delete w.SpeechRecognition;
        delete w.webkitSpeechRecognition;
      }
    }, voiceStt);
    const calls: { method: string; path: string; body: unknown }[] = [];
    let status = "done";
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^\/api/, "");
      calls.push({ method: req.method(), path, body: req.postData() ? JSON.parse(req.postData()!) : null });
      const json = (data: unknown, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
      const task = { id: TASK, eventId: "e1", vertical: "personal", intent: "question", route: "agent", urgency: 0.3, status, prompt: "x", role: "chief-of-staff", createdAt: at(0), updatedAt: at(0) };
      const run = (id: string, s: number, text: string) => ({ id, taskId: TASK, runner: "t", status: "succeeded", result: text, error: null, costUsd: 0, sessionId: "s", startedAt: at(s), finishedAt: at(s + 2), messages: [{ type: "text", text }] });
      if (path === "/verticals") return json([{ id: "personal", name: "Personal" }]);
      if (path === "/stats") return json({ pendingApprovals: 0, costTodayUsd: 0 });
      if (path === "/voice/config") return json({ stt: null, tts: null, maxUploadBytes: 0, maxSeconds: 60, language: "en-GB", calendar: false });
      if (path === "/chat") return json({ event: { id: "e1" }, task: { ...task, status: "queued" } }, 201);
      if (path === `/tasks/${TASK}/reply`) return json({ ...task, status: "queued" });
      if (path === `/tasks/${TASK}/chain-proposals`) return json({ taskIds: [TASK], proposals: [] });
      if (path === `/tasks/${TASK}`) return json({ task, event: null, proposals: [], runs: [run("r1", 1, "Order 1042 shipped on Monday.")] });
      return json({ error: `unmocked ${path}` }, 404);
    });
    return { calls, setStatus: (s: string) => (status = s) };
  }

  it("keeps the chat when leaving the page or reloading, until New chat or an hour idle", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await setup(page, false);
    await page.goto(`${base}/#/chat`);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor({ timeout: 20_000 });
    await box.fill("has order 1042 shipped?");
    await box.press("Enter");
    await page.locator(".bubble.me", { hasText: "has order 1042 shipped?" }).waitFor();

    // Away and back: the question is still there, with its answer from the task.
    await page.goto(`${base}/#/inbox`);
    await page.goto(`${base}/#/chat`);
    await page.locator(".bubble.me", { hasText: "has order 1042 shipped?" }).waitFor({ timeout: 10_000 });
    await page.locator(".bubble.agent", { hasText: "Order 1042 shipped on Monday." }).waitFor();

    // A reload too.
    await page.reload();
    await page.locator(".bubble.agent", { hasText: "Order 1042 shipped on Monday." }).waitFor({ timeout: 20_000 });
    expect(await page.locator(".turn").count()).toBe(1);

    // Last used yesterday, and quiet for over two hours since: a fresh chat (see chat-store.test.ts for the rule).
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("cc.chat.thread")!);
      saved.lastActive = Date.now() - 26 * 60 * 60_000;
      localStorage.setItem("cc.chat.thread", JSON.stringify(saved));
    });
    await page.reload();
    await page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 20_000 });
    expect(await page.locator(".turn").count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("cc.chat.thread"))).toBeNull();

    // New chat clears it straight away.
    await page.getByRole("textbox", { name: "Message" }).fill("again?");
    await page.getByRole("textbox", { name: "Message" }).press("Enter");
    await page.locator(".turn").first().waitFor();
    await page.getByRole("button", { name: "New chat" }).click();
    expect(await page.locator(".turn").count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("cc.chat.thread"))).toBeNull();
    expect(errors).toEqual([]);
  }, 90_000);

  it("dictates into the box with the mic, and Send while dictating sends what was said", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { calls } = await setup(page, true);
    await page.goto(`${base}/#/chat`);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor({ timeout: 20_000 });
    await box.fill("dms:");

    const mic = page.getByRole("button", { name: "Dictate" });
    await mic.click();
    const stop = page.getByRole("button", { name: "Done dictating" });
    expect(await stop.getAttribute("aria-pressed")).toBe("true");
    await page.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say("where is order 1042"));
    await expect.poll(() => box.inputValue()).toBe("dms: where is order 1042");
    if (process.env.TASK_SHOTS) await page.screenshot({ path: `${process.env.TASK_SHOTS}/chat-dictating.png` });
    await stop.click();
    await page.getByRole("button", { name: "Dictate" }).waitFor();
    expect(await box.inputValue()).toBe("dms: where is order 1042");
    expect(calls.some((c) => c.path === "/chat")).toBe(false); // dictation never sends by itself

    // Talk, then Send straight away: listening ends and everything said goes.
    await box.fill("");
    await page.getByRole("button", { name: "Dictate" }).click();
    await page.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say("remind me to call the bank"));
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => calls.find((c) => c.path === "/chat")?.body).toMatchObject({ text: "remind me to call the bank" });
    expect(errors).toEqual([]);
  }, 60_000);

  it("opens a task at its latest answer, with the reply box last", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await setup(page, false);
    // A long answer, so the page scrolls.
    await page.route(`**/api/tasks/${TASK}`, (route) => {
      const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the answer.`).join("\n\n");
      const task = { id: TASK, eventId: "e1", vertical: "personal", intent: "question", route: "agent", urgency: 0.3, status: "done", prompt: "has order 1042 shipped?", role: "chief-of-staff", createdAt: at(0), updatedAt: at(0) };
      const run = { id: "r1", taskId: TASK, runner: "claude-code", status: "succeeded", result: long, error: null, costUsd: 0.01, sessionId: "s", startedAt: at(1), finishedAt: at(3), messages: [{ type: "text", text: long }] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task, event: null, proposals: [], runs: [run] }) });
    });
    await page.goto(`${base}/#/task/${TASK}`);
    const reply = page.locator("form.reply-box");
    await reply.waitFor({ timeout: 20_000 });
    // Reading order: the task, the conversation, then the box to reply in.
    const order = await page.evaluate(() => {
      const conv = document.querySelector(".run-card")!;
      const box = document.querySelector("form.reply-box")!;
      return conv.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING ? "conversation, then reply" : "reply first";
    });
    expect(order).toBe("conversation, then reply");
    await expect
      .poll(() => page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160))
      .toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  }, 60_000);

  it("dictates into the task's reply box too, and Send while dictating sends the reply", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { calls } = await setup(page, true);
    await page.goto(`${base}/#/task/${TASK}`);
    const reply = page.locator("form.reply-box");
    await reply.waitFor({ timeout: 20_000 });
    const box = reply.getByRole("textbox", { name: "Reply to the agent" });
    await box.fill("Yes,");

    await reply.getByRole("button", { name: "Dictate" }).click();
    const stop = reply.getByRole("button", { name: "Done dictating" });
    expect(await stop.getAttribute("aria-pressed")).toBe("true");
    await page.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say("send it today"));
    await expect.poll(() => box.inputValue()).toBe("Yes, send it today");
    if (process.env.TASK_SHOTS) await page.screenshot({ path: `${process.env.TASK_SHOTS}/task-reply-dictating.png` });
    await stop.click();
    await reply.getByRole("button", { name: "Dictate" }).waitFor();
    expect(calls.some((c) => c.path === `/tasks/${TASK}/reply`)).toBe(false); // dictation never sends by itself

    await box.fill("");
    await reply.getByRole("button", { name: "Dictate" }).click();
    await page.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say("use the tracked courier"));
    await reply.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => calls.find((c) => c.path === `/tasks/${TASK}/reply`)?.body).toMatchObject({ text: "use the tracked courier" });
    expect(errors).toEqual([]);
  }, 60_000);

  it("hides the mic where the device can't listen", async () => {
    const page = await browser.newPage();
    await setup(page, false);
    await page.goto(`${base}/#/chat`);
    await page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 20_000 });
    // No recognition engine on the device, and no speech-to-text on the server.
    expect(await page.getByRole("button", { name: "Dictate" }).count()).toBe(0);
    await page.goto(`${base}/#/task/${TASK}`);
    await page.locator("form.reply-box").waitFor({ timeout: 20_000 });
    expect(await page.getByRole("button", { name: "Dictate" }).count()).toBe(0);
  }, 60_000);
});
