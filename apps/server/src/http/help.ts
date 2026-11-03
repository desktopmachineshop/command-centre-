import { createHmac } from "node:crypto";
import { Hono } from "hono";

/**
 * In-app help: the PWA's "?" button and help panel come from the OpenD docs site
 * (docs/ in this repo, published at OPEND_DOCS_URL). See docs/SETUP.md, "In-app help".
 */
export interface HelpConfig {
  /** Docs site base URL, no trailing slash. Also the `aud` of embed tokens. */
  docsUrl: string;
  /** App name in docs/help-contexts.yaml and each topic's `resourceid appname`. */
  app: string;
  /** The docs site's OPEND_EMBED_SECRET. Without it the PWA opens context links in a new tab. */
  embedSecret?: string;
  /** OpenD organization slug of the signed-in users, when they are registered in one. */
  org?: string;
}

/** How long an embed token lasts. OpenD accepts at most 600 seconds. */
export const HELP_TOKEN_TTL_SECONDS = 300;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An HS256 embed token naming the signed-in user, for OpenD's /embed/session. */
export function signHelpToken(cfg: HelpConfig & { embedSecret: string }, email: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const claims: Record<string, unknown> = { email, aud: cfg.docsUrl, iat, exp: iat + HELP_TOKEN_TTL_SECONDS };
  if (cfg.org) claims.org = cfg.org;
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  const signature = createHmac("sha256", cfg.embedSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

/** /help/config and /help/token. Mounted behind the API's sign-in check. */
export function helpRoutes(cfg: HelpConfig) {
  const app = new Hono();

  /** What the PWA needs to load the widget. Says nothing about the secret beyond whether it is set. */
  app.get("/help/config", (c) => c.json({ docsUrl: cfg.docsUrl, app: cfg.app, embed: Boolean(cfg.embedSecret) }));

  /** A fresh embed token for the signed-in user. Never cached. */
  app.get("/help/token", (c) => {
    c.header("cache-control", "no-store");
    if (!cfg.embedSecret) return c.json({ error: "In-app help sign-in is not set up (OPEND_EMBED_SECRET)" }, 404);
    const p = c.get("principal");
    if (p.kind !== "user") return c.json({ error: "Help sign-in needs a signed-in user; the admin token has no email" }, 400);
    return c.text(signHelpToken({ ...cfg, embedSecret: cfg.embedSecret }, p.user.email));
  });

  return app;
}
