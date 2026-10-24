import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { bearer, tokenMatches } from "../auth";
import { AuthError, AuthService, GENERIC_LOGIN_ERROR, LOCKED_ERROR, SESSION_TTL_MS } from "./service";
import { publicUser, type Role, type UserRecord } from "./store";

/** Who made an /api request: the admin Bearer token (automation, tests) or a signed-in user. */
export type Principal = { kind: "token" } | { kind: "user"; user: UserRecord; sessionId: string };

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
  }
}

export interface AuthHttpOptions {
  adminToken: string;
  /** Reverse proxies in front of the server (Railway: 1). The client IP is that many entries from the right of X-Forwarded-For. */
  trustedProxyHops: number;
}

/** Roles that may use the dashboard API. A future VA role would get its own, narrower list. */
const API_ROLES: readonly Role[] = ["admin"];

export const COOKIE_NAME = "cc_session";
/** Header the PWA sends on every request. A cross-site page can't add it without a CORS preflight, which this server never grants. */
export const CSRF_HEADER = "x-cc-request";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True on https, either directly or behind a TLS-terminating proxy (Railway sets X-Forwarded-Proto). */
export function isSecure(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  return new URL(c.req.url).protocol === "https:";
}

export function clientIp(c: Context, hops: number): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff && hops > 0) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    // The right-most entries were added by our own proxies; anything further left is client-supplied.
    const ip = parts[Math.max(0, parts.length - hops)];
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // in-process requests (tests) have no socket
  }
}

/** `__Host-cc_session` on https (no Domain, Path=/, Secure), plain `cc_session` on local http. */
export function readSessionToken(c: Context): string | undefined {
  return isSecure(c) ? getCookie(c, COOKIE_NAME, "host") : getCookie(c, COOKIE_NAME);
}

export function setSessionCookie(c: Context, token: string): void {
  const secure = isSecure(c);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    ...(secure ? { prefix: "host" as const } : {}),
  });
}

export function clearSessionCookie(c: Context): void {
  const secure = isSecure(c);
  deleteCookie(c, COOKIE_NAME, { httpOnly: true, secure, sameSite: "Lax", path: "/", ...(secure ? { prefix: "host" as const } : {}) });
}

/** Origin's host equals the host the request was sent to. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin || origin === "null") return false;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const targets = [c.req.header("host"), c.req.header("x-forwarded-host")?.split(",")[0]?.trim()]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase());
  return targets.includes(host);
}

/** A state-changing request without a Bearer token must carry X-CC-Request: 1 or a same-origin Origin. */
export function csrfOk(c: Context): boolean {
  if (SAFE_METHODS.has(c.req.method)) return true;
  if (c.req.header(CSRF_HEADER) === "1") return true;
  return sameOrigin(c);
}

const csrfError = (c: Context) => c.json({ error: "missing X-CC-Request header (CSRF check)" }, 403);

/**
 * Resolves the caller from the Authorization header (admin token) or the session cookie.
 * Returns a Response to send instead when the caller is not allowed.
 */
async function resolvePrincipal(c: Context, auth: AuthService, opts: AuthHttpOptions): Promise<Principal | Response> {
  const header = c.req.header("authorization");
  if (header) {
    // An explicit Authorization header is never mixed with a cookie: it must be the admin token.
    return tokenMatches(bearer(header), opts.adminToken) ? { kind: "token" } : c.json({ error: "unauthorized" }, 401);
  }
  // No credentials at all is a plain 401; CSRF only matters once a session cookie is present.
  const token = readSessionToken(c);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  if (!csrfOk(c)) return csrfError(c);
  const found = await auth.authenticate(token, clientIp(c, opts.trustedProxyHops));
  if (!found) {
    clearSessionCookie(c);
    return c.json({ error: "unauthorized" }, 401);
  }
  if (found.refreshed) setSessionCookie(c, token);
  return { kind: "user", user: found.user, sessionId: found.session.id };
}

/** For /api/*: a valid session cookie (role admin) OR the admin Bearer token. */
export function requireApiAuth(auth: AuthService, opts: AuthHttpOptions): MiddlewareHandler {
  return async (c, next) => {
    const p = await resolvePrincipal(c, auth, opts);
    if (p instanceof Response) return p;
    if (p.kind === "user" && !API_ROLES.includes(p.user.role)) return c.json({ error: "forbidden" }, 403);
    c.set("principal", p);
    await next();
  };
}

/** For the WebSocket upgrade: a session from the cookie, only when the Origin is our own (no cross-site hijacking). */
export async function sessionFromUpgrade(c: Context, auth: AuthService, opts: AuthHttpOptions): Promise<{ user: UserRecord; sessionId: string } | null> {
  const token = readSessionToken(c);
  if (!token || !sameOrigin(c)) return null;
  const found = await auth.authenticate(token, clientIp(c, opts.trustedProxyHops));
  if (!found || !API_ROLES.includes(found.user.role)) return null;
  return { user: found.user, sessionId: found.session.id };
}

const Credentials = z.object({
  email: z.string().max(320),
  password: z.string().max(1024),
  totp: z.string().max(64).optional(),
});
const NewUser = z.object({ email: z.string().max(320), name: z.string().max(200), password: z.string().max(1024) });

/** /api/auth/*: status, setup, login, logout, me, password, sessions and TOTP. */
export function authRoutes(auth: AuthService, opts: AuthHttpOptions) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    console.error("[auth]", err);
    return c.json({ error: "internal error" }, 500);
  });

  // CSRF applies to every state-changing call here, login and setup included, unless it carries a Bearer token.
  app.use("*", async (c, next) => {
    if (!c.req.header("authorization") && !csrfOk(c)) return csrfError(c);
    await next();
  });

  const ip = (c: Context) => clientIp(c, opts.trustedProxyHops);
  const locked = (c: Context, ms: number) => {
    c.header("Retry-After", String(Math.max(1, Math.ceil(ms / 1000))));
    return c.json({ error: LOCKED_ERROR }, 429);
  };

  /** Public: whether first-run setup is still needed. Says nothing else. */
  app.get("/status", async (c) => c.json({ setupRequired: await auth.setupRequired() }));

  /** First-run: only while no user exists, and only with the ADMIN_TOKEN as Bearer, so a stranger can't claim the server. */
  app.post("/setup", async (c) => {
    const wait = auth.ipRetryAfter(ip(c));
    if (wait > 0) return locked(c, wait);
    if (!tokenMatches(bearer(c.req.header("authorization")), opts.adminToken)) {
      auth.ipFailed(ip(c));
      return c.json({ error: "The admin token is incorrect" }, 401);
    }
    const body = NewUser.parse(await c.req.json());
    const user = await auth.setupFirstUser(body);
    const { token } = await auth.createSession(user.id, ip(c), c.req.header("user-agent") ?? null);
    setSessionCookie(c, token);
    return c.json({ user: publicUser(user) }, 201);
  });

  app.post("/login", async (c) => {
    const body = Credentials.parse(await c.req.json());
    const result = await auth.login({ ...body, ip: ip(c), userAgent: c.req.header("user-agent") ?? null });
    if (result.ok) {
      setSessionCookie(c, result.token);
      return c.json({ user: result.user });
    }
    switch (result.reason) {
      case "locked":
        return locked(c, result.retryAfterMs);
      case "totp_required":
        return c.json({ error: "Enter the code from your authenticator app", totpRequired: true }, 401);
      case "totp_invalid":
        return c.json({ error: "That code is incorrect", totpRequired: true }, 401);
      default:
        return c.json({ error: GENERIC_LOGIN_ERROR }, 401);
    }
  });

  /** Signing out is allowed even when the session has already gone. */
  app.post("/logout", async (c) => {
    const token = readSessionToken(c);
    if (token) {
      const found = await auth.authenticate(token);
      if (found) await auth.logout(found.session.id);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // Everything below needs a caller.
  app.use("*", requireApiAuth(auth, opts));

  /** Account routes need a signed-in user, not the admin token. */
  const userOf = (c: Context): Extract<Principal, { kind: "user" }> => {
    const p = c.get("principal");
    if (p.kind !== "user") throw new AuthError(400, "This needs a signed-in user; the admin token has no account");
    return p;
  };

  app.get("/me", async (c) => {
    const p = c.get("principal");
    if (p.kind === "token") return c.json({ via: "token", user: null });
    return c.json({
      via: "session",
      sessionId: p.sessionId,
      user: publicUser(p.user),
      recoveryCodesLeft: p.user.totpEnabled ? await auth.store.recoveryCodesLeft(p.user.id) : 0,
    });
  });

  app.post("/password", async (c) => {
    const p = userOf(c);
    const body = z.object({ currentPassword: z.string().max(1024), newPassword: z.string().max(1024) }).parse(await c.req.json());
    const revoked = await auth.changePassword(p.user, body.currentPassword, body.newPassword, p.sessionId, ip(c));
    return c.json({ ok: true, revokedSessions: revoked });
  });

  app.get("/sessions", async (c) => {
    const p = userOf(c);
    const sessions = await auth.store.listSessions(p.user.id);
    return c.json(sessions.map(({ userId: _u, ...s }) => ({ ...s, current: s.id === p.sessionId })));
  });

  /** Signs out one other device, or every other device with id "others". */
  app.delete("/sessions/:id", async (c) => {
    const p = userOf(c);
    const id = c.req.param("id");
    if (id === "others") return c.json({ ok: true, revoked: await auth.revokeOtherSessions(p.user.id, p.sessionId) });
    if (!(await auth.revokeSession(p.user.id, id))) return c.json({ error: "not found" }, 404);
    if (id === p.sessionId) clearSessionCookie(c);
    return c.json({ ok: true, revoked: 1 });
  });

  app.post("/totp/setup", async (c) => c.json(await auth.beginTotp(userOf(c).user)));

  app.post("/totp/enable", async (c) => {
    const { code } = z.object({ code: z.string().max(16) }).parse(await c.req.json());
    return c.json(await auth.enableTotp(userOf(c).user, code));
  });

  app.post("/totp/disable", async (c) => {
    const { password } = z.object({ password: z.string().max(1024) }).parse(await c.req.json());
    await auth.disableTotp(userOf(c).user, password, ip(c));
    return c.json({ ok: true });
  });

  return app;
}
