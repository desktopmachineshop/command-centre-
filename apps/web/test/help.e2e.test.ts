/**
 * Context-sensitive help (src/help.ts): every help key in the app exists in the docs, the
 * header "?" and F1 open the OpenD panel on the current route, and without an embed secret
 * "?" opens a context link in a new tab. The browser part runs in real Chromium with the
 * server and the docs site mocked, and is skipped when no Chromium is installed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextLink, helpPath } from "../src/help";

const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const SHOTS = process.env.HELP_SHOTS; // a folder for screenshots, when set
const DOCS = "https://command-centre.opend.app";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const files = (dir: string, ext: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
  });

describe("help keys", () => {
  const docKeys = new Set(
    files(here("../../../docs/topics"), ".dita").flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/<resourceid appname="command-centre" appid="([^"]+)"/g)].map((m) => m[1]!),
    ),
  );
  /** A key is covered by its own topic or, failing that, a parent's. */
  const covered = (key: string) => key.split(".").some((_, i, parts) => docKeys.has(parts.slice(0, parts.length - i).join(".")));

  it("every data-help-key and data-help-pane in the app has its own topic in docs/", () => {
    const used = files(here("../src"), ".tsx").flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/data-help-(?:key|pane)="([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((k) => !docKeys.has(k))).toEqual([]);
  });

  it("every page in NAV has a route in help-contexts.yaml that resolves to a topic", () => {
    const routes = Object.fromEntries(
      [...readFileSync(here("../../../docs/help-contexts.yaml"), "utf8").matchAll(/^ {6}(\/[^:\s]*(?::\w+)?[^:\s]*): ([\w.-]+)$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    const nav = [...readFileSync(here("../src/App.tsx"), "utf8").matchAll(/\{ key: "([\w-]+)", label:/g)].map((m) => m[1]!);
    expect(nav.length).toBeGreaterThan(10);
    for (const page of nav) {
      const key = routes[`/${page}`] ?? routes[`/${page}/**`];
      expect(key, `route for /${page}`).toBeTruthy();
      expect(covered(key!), `topic for ${key}`).toBe(true);
    }
  });

  it("maps hash routes to app paths and builds context links", () => {
    expect(helpPath("")).toBe("/inbox");
    expect(helpPath("#/task/abc?n=1")).toBe("/task/abc");
    expect(helpPath("#/brain/dms%2Fnote.md")).toBe("/brain/dms%2Fnote.md");
    expect(contextLink({ docsUrl: DOCS, app: "command-centre" }, "/approvals", { focus: "approvals.revise" })).toBe(
      `${DOCS}/context/command-centre?focus=approvals.revise&path=%2Fapprovals`,
    );
  });
});

/** A stand-in for the docs site's /embed/opend-help.js that records every call. */
const FAKE_WIDGET = `
  window.__help = [];
  let open = false;
  window.OpenDHelp = {
    init: (o) => window.__help.push(["init", { docsUrl: o.docsUrl, app: o.app, token: typeof o.getToken }]),
    setContext: (c) => window.__help.push(["setContext", c]),
    open: (c) => { open = true; window.__help.push(["open", c ?? null]); },
    close: () => { open = false; window.__help.push(["close"]); },
    toggle: (c) => { open = !open; window.__help.push(["toggle", c ?? null]); },
    isOpen: () => open,
  };`;

describe.skipIf(!existsSync(CHROMIUM))("help button (Playwright)", () => {
  let vite: ViteDevServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    process.env.CC_SERVER_URL ??= "http://127.0.0.1:9";
    vite = await createServer({ root: here(".."), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
    await vite.listen();
    base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  async function open(page: Page, embed: boolean, hash = "#/inbox") {
    await page.addInitScript(() => {
      (window as unknown as { WebSocket: unknown }).WebSocket = class {
        send() {}
        close() {}
      };
      window.open = ((url: string) => {
        (window as unknown as { __opened: string[] }).__opened = [...((window as unknown as { __opened?: string[] }).__opened ?? []), url];
        return null;
      }) as typeof window.open;
    });
    await page.route(`${DOCS}/embed/opend-help.js`, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_WIDGET }));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      const json = (data: unknown, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
      if (path === "/auth/me") return json({ via: "session", user: { id: "u1", email: "dave@example.com", name: "Dave" } });
      if (path === "/help/config") return json({ docsUrl: DOCS, app: "command-centre", embed });
      if (path === "/stats") return json({ day: "2026-11-03", pendingApprovals: 1, costTodayUsd: 0.4, costTodayByVertical: {}, budgets: { globalUsd: 5, verticals: {} } });
      if (path === "/verticals") return json([{ id: "dms", name: "Desktop Machine Shop" }]);
      if (path === "/proposals") return json([]);
      if (path === "/tasks") return json([]);
      if (path === "/digest") return json({ totals: { costUsd: 0.4, counts: { done: 3, failed: 0, deferred: 0, autoActions: 1, pendingApprovals: 1, jobs: 0 } }, digests: [] });
      if (path === "/notifications/unread-count") return json({ unread: 0 });
      return json({ error: `unmocked ${path}` }, 404);
    });
    await page.goto(`${base}/${hash}`);
    await page.getByRole("button", { name: /Help for this page/ }).waitFor({ timeout: 20_000 });
  }
  const calls = (page: Page) => page.evaluate(() => (window as unknown as { __help?: unknown[] }).__help ?? []);

  it("loads the OpenD widget, follows the route, and opens on ? and F1", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await open(page, true);
    await expect.poll(() => calls(page)).toContainEqual(["setContext", { path: "/inbox" }]);
    expect((await calls(page))[0]).toEqual(["init", { docsUrl: DOCS, app: "command-centre", token: "function" }]);

    await page.evaluate(() => (location.hash = "#/approvals"));
    await expect.poll(() => calls(page)).toContainEqual(["setContext", { path: "/approvals" }]);

    await page.getByRole("button", { name: /Help for this page/ }).click();
    expect(await calls(page)).toContainEqual(["toggle", null]);
    await page.getByRole("button", { name: /Help for this page/ }).click(); // closes it again
    await page.keyboard.press("F1");
    expect((await calls(page)).at(-1)).toEqual(["open", null]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/help-button-desktop.png` });
    expect(errors).toEqual([]);
  }, 60_000);

  it("without an embed secret, ? opens the context link for the route and the focused field", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await open(page, false, "#/chat");
    await page.getByRole("combobox", { name: "Send to" }).focus();
    await page.keyboard.press("F1");
    const opened = await page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? []);
    expect(opened).toEqual([`${DOCS}/context/command-centre?focus=chat.send-to&path=%2Fchat`]);
    expect(await calls(page)).toEqual([]); // no widget loaded
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/help-button-phone.png` });
  }, 60_000);
});
