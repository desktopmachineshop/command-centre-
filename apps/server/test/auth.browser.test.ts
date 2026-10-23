import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Decode, hotp, totpStep } from "../src/accounts/totp";
import { ADMIN, DB_URL, makeServer, resetDatabase, serveServer } from "./helpers";

/**
 * The PWA in a real browser against a locally started server: first-run setup,
 * sign-in, the cookie session over WebSocket, 2FA and the admin-token fallback.
 * Needs a Chromium binary (PW_CHROMIUM, default /opt/pw-browsers/chromium) and a
 * built PWA (`pnpm --filter @cc/web build`); skipped otherwise.
 */
const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const WEB_DIST = join(import.meta.dirname, "../../web/dist");
const ready = !!DB_URL && existsSync(CHROMIUM) && existsSync(join(WEB_DIST, "index.html"));

const EMAIL = "dave@example.com";
const PASSWORD = "browser-password-1";

describe.skipIf(!ready)("auth in the browser (Playwright)", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  let net: Awaited<ReturnType<typeof serveServer>>;
  let browser: Browser;

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { WEB_DIST_DIR: WEB_DIST }, overrides: { scrypt: { ln: 10, r: 8, p: 1 } } });
    net = await serveServer(ctx.server);
    browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await net?.close();
    await ctx?.server.stop();
  });

  const signedIn = async (page: Page) => {
    await expect.poll(() => page.locator("nav.nav").isVisible(), { timeout: 10_000 }).toBe(true);
    // The live dot turns on once the WebSocket is accepted (by cookie, with an empty hello token).
    await expect.poll(() => page.locator(".dot.on").count(), { timeout: 10_000 }).toBe(1);
  };

  const signOut = async (page: Page) => {
    await page.goto(`${net.url}/#/settings`);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign in" }).waitFor();
  };

  it("first-run setup, then sign in and out with email and password", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(net.url);

    await page.getByRole("heading", { name: "Set up Command Centre" }).waitFor();
    const fill = async (token: string) => {
      await page.getByLabel("Admin token").fill(token);
      await page.getByLabel("Name").fill("Dave");
      await page.getByLabel("Email").fill(EMAIL);
      await page.getByLabel(/^Password/).fill(PASSWORD);
      await page.getByLabel("Repeat password").fill(PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
    };
    await fill("not-the-admin-token");
    await page.getByText("The admin token is incorrect").waitFor();
    await fill(ADMIN);
    await signedIn(page);

    // The session is an HttpOnly cookie; nothing secret is left in localStorage.
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === "cc_session")).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(await page.evaluate(() => localStorage.getItem("cc.connection"))).toBeNull();
    expect(await page.evaluate("document.cookie")).toBe("");

    // Survives a reload.
    await page.reload();
    await signedIn(page);

    await signOut(page);
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill("wrong-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Incorrect email or password").waitFor();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await signedIn(page);

    // Settings shows this device.
    await page.goto(`${net.url}/#/settings`);
    await page.getByText("this device", { exact: true }).waitFor();
    await context.close();
  });

  it("turns on two-factor and then asks for the code at sign-in", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(net.url);
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await signedIn(page);

    await page.goto(`${net.url}/#/settings`);
    await page.getByRole("button", { name: "Set up two-factor" }).click();
    await page.getByRole("img", { name: /QR code/ }).waitFor();
    const secret = (await page.locator("code").filter({ hasText: /^[A-Z2-7]{32}$/ }).textContent())!;
    const code = (ms: number) => hotp(base32Decode(secret), totpStep(ms));
    await page.getByLabel("Code").fill(code(Date.now()));
    await page.getByRole("button", { name: "Turn on" }).click();
    await page.getByText("Save these recovery codes").waitFor();

    await signOut(page);
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Enter the 6-digit code").waitFor();
    // The code used to turn it on can't be replayed, so use the next one.
    await page.getByLabel("Code").fill(code(Date.now() + 30_000));
    await page.getByRole("button", { name: "Verify" }).click();
    await signedIn(page);
    await context.close();
  });

  it("still signs in with an admin token for advanced use", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(net.url);
    await page.getByText("Use an admin token instead").click();
    await page.getByLabel("Admin token").fill(ADMIN);
    await page.getByRole("button", { name: "Connect" }).click();
    await signedIn(page);
    await page.goto(`${net.url}/#/settings`);
    await page.getByText("signed in with the admin token").waitFor();
    await context.close();
  });
});
