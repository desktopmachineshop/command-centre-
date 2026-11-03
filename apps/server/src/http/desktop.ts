import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../accounts/http";
import { bearer, tokenMatches } from "../auth";
import { type DesktopService, LinkError, updateFor } from "../desktop";
import { DESKTOP_UPLOAD_AUDIENCE, type GithubOidcVerifier, OidcError } from "../github-oidc";

export interface DesktopApiDeps {
  desktop: DesktopService;
  adminToken: string;
  /** Verifies the Desktop workflow's GitHub OIDC token for installer uploads. */
  verifyOidc: GithubOidcVerifier;
  /** `owner/repo` whose Desktop workflow may upload installers. */
  repository: string;
  installerMaxBytes: number;
  /** The server's public address, for the download URL in an update answer (PUBLIC_BASE_URL). */
  publicBaseUrl?: () => string | undefined;
  /** Proxies in front of the server, for the client IP automatic linking compares (TRUSTED_PROXY_HOPS). */
  trustedProxyHops?: number;
}

const onError = (err: Error, c: Context) => {
  if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
  if (err instanceof LinkError) return c.json({ error: err.message }, err.status);
  if (err instanceof OidcError) return c.json({ error: err.message }, 401);
  console.error("[desktop]", err);
  return c.json({ error: "internal error" }, 500);
};

const Start = z.object({ name: z.string().max(200).default("") });
const Approve = z.object({ autoKey: z.string().min(1).max(200).optional() });
const Poll = z.object({ pollToken: z.string().min(1).max(200) });
const InstallerMeta = z.object({
  version: z.string().regex(/^[\w.+-]{1,64}$/),
  filename: z.string().regex(/^[\w .()+-]{1,120}\.(exe|msi)$/),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  /** The contents of the installer's `.sig` file (base64), sent as the X-CC-Update-Signature header. */
  signature: z.string().regex(/^[A-Za-z0-9+/=]{20,4096}$/).optional(),
});

/** This server's address as the app sees it: PUBLIC_BASE_URL, else the request's own host. */
function publicBase(c: Context, configured: string | undefined): string {
  if (configured) return configured;
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  return `${proto}://${c.req.header("host") ?? url.host}`;
}

/**
 * Before /api's sign-in check: the desktop app's link handshake (it has no credentials yet)
 * and the installer upload (GitHub OIDC from the Desktop workflow, or the admin token).
 */
export function desktopPublicRoutes(deps: DesktopApiDeps) {
  const app = new Hono();
  app.onError(onError);

  app.post("/desktop/link", async (c) => {
    const body = Start.parse(await c.req.json().catch(() => ({})));
    return c.json(deps.desktop.startLink(body.name, clientIp(c, deps.trustedProxyHops ?? 1)), 201);
  });

  app.post("/desktop/link/poll", async (c) => {
    const body = Poll.parse(await c.req.json().catch(() => ({})));
    return c.json(deps.desktop.poll(body.pollToken));
  });

  app.put("/desktop/installer", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "unauthorized" }, 401);
    if (!tokenMatches(token, deps.adminToken)) {
      await deps.verifyOidc(token, { audience: DESKTOP_UPLOAD_AUDIENCE, repository: deps.repository, workflowPath: ".github/workflows/desktop.yml" });
    }
    const meta = InstallerMeta.parse({
      version: c.req.query("version"),
      filename: c.req.query("filename"),
      commit: c.req.query("commit") || undefined,
      signature: c.req.header("x-cc-update-signature")?.trim() || undefined,
    });
    if (!c.req.raw.body) return c.json({ error: "no file" }, 400);
    const info = await deps.desktop.saveInstaller(c.req.raw.body, { ...meta, commit: meta.commit ?? null, signature: meta.signature ?? null }, deps.installerMaxBytes);
    console.log(`[desktop] installer ${info.filename} (${info.version}, ${info.size} bytes, ${info.signature ? "signed for updates" : "unsigned"}) uploaded`);
    return c.json(info, 201);
  });

  // --- in-app updates (the Tauri updater in apps/desktop): a linked computer's device token only ---

  /** The device behind the request's bearer token, or null (unlinked apps don't update). */
  const device = async (c: Context) => deps.desktop.verify(bearer(c.req.header("authorization")));

  // 204 when up to date; otherwise what Tauri's updater expects: version, url, signature.
  app.get("/desktop/update", async (c) => {
    if (!(await device(c))) return c.json({ error: "unauthorized" }, 401);
    const current = c.req.query("current_version") ?? "0.0.0";
    const info = updateFor(deps.desktop.installer(), current);
    if (!info) return c.body(null, 204);
    return c.json({
      version: info.version.split("+")[0],
      pub_date: info.uploadedAt,
      url: `${publicBase(c, deps.publicBaseUrl?.())}/api/desktop/update/download`,
      signature: info.signature,
      notes: info.commit ? `Build ${info.commit.slice(0, 7)}` : "",
    });
  });

  app.get("/desktop/update/download", async (c) => {
    if (!(await device(c))) return c.json({ error: "unauthorized" }, 401);
    const file = deps.desktop.installerFile();
    if (!file) return c.json({ error: "no build" }, 404);
    const stream = Readable.toWeb(deps.desktop.openInstaller(file.path)) as ReadableStream;
    return c.body(stream, 200, {
      "content-type": "application/octet-stream",
      "content-length": String(file.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  });

  return app;
}

/** Behind /api's sign-in check: approving links, the linked computers, and the download. */
export function desktopApiRoutes(deps: DesktopApiDeps) {
  const app = new Hono();
  app.onError(onError);

  app.get("/desktop/link/:code", (c) => {
    const info = deps.desktop.linkInfo(c.req.param("code"));
    return info ? c.json(info) : c.json({ error: "This link code has expired. Start linking again from the desktop app." }, 404);
  });

  app.post("/desktop/link/:code/approve", async (c) => {
    const p = c.get("principal");
    const body = Approve.parse(await c.req.json().catch(() => ({})));
    const auto = body.autoKey ? { key: body.autoKey, ip: clientIp(c, deps.trustedProxyHops ?? 1) } : undefined;
    const device = await deps.desktop.approve(c.req.param("code"), p.kind === "user" ? p.user.id : null, auto);
    return c.json(device, 201);
  });

  app.get("/desktop/devices", async (c) => c.json(await deps.desktop.list()));

  app.delete("/desktop/devices/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success || !(await deps.desktop.revoke(id.data))) return c.json({ error: "not found" }, 404);
    return c.json({ revoked: true });
  });

  app.get("/desktop/installer", (c) => c.json({ installer: deps.desktop.installer() }));

  app.get("/desktop/download", (c) => {
    const file = deps.desktop.installerFile();
    if (!file) return c.json({ error: "The desktop app hasn't been built yet. Run the Desktop workflow in GitHub Actions." }, 404);
    const stream = Readable.toWeb(deps.desktop.openInstaller(file.path)) as ReadableStream;
    return c.body(stream, 200, {
      "content-type": "application/octet-stream",
      "content-length": String(file.size),
      "content-disposition": `attachment; filename="${file.info.filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  });

  return app;
}
