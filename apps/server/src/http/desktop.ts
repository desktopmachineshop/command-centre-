import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { bearer, tokenMatches } from "../auth";
import { type DesktopService, LinkError } from "../desktop";
import { DESKTOP_UPLOAD_AUDIENCE, type GithubOidcVerifier, OidcError } from "../github-oidc";

export interface DesktopApiDeps {
  desktop: DesktopService;
  adminToken: string;
  /** Verifies the Desktop workflow's GitHub OIDC token for installer uploads. */
  verifyOidc: GithubOidcVerifier;
  /** `owner/repo` whose Desktop workflow may upload installers. */
  repository: string;
  installerMaxBytes: number;
}

const onError = (err: Error, c: Context) => {
  if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
  if (err instanceof LinkError) return c.json({ error: err.message }, err.status);
  if (err instanceof OidcError) return c.json({ error: err.message }, 401);
  console.error("[desktop]", err);
  return c.json({ error: "internal error" }, 500);
};

const Start = z.object({ name: z.string().max(200).default("") });
const Poll = z.object({ pollToken: z.string().min(1).max(200) });
const InstallerMeta = z.object({
  version: z.string().regex(/^[\w.+-]{1,64}$/),
  filename: z.string().regex(/^[\w .()+-]{1,120}\.(exe|msi)$/),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
});

/**
 * Before /api's sign-in check: the desktop app's link handshake (it has no credentials yet)
 * and the installer upload (GitHub OIDC from the Desktop workflow, or the admin token).
 */
export function desktopPublicRoutes(deps: DesktopApiDeps) {
  const app = new Hono();
  app.onError(onError);

  app.post("/desktop/link", async (c) => {
    const body = Start.parse(await c.req.json().catch(() => ({})));
    return c.json(deps.desktop.startLink(body.name), 201);
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
    const meta = InstallerMeta.parse({ version: c.req.query("version"), filename: c.req.query("filename"), commit: c.req.query("commit") || undefined });
    if (!c.req.raw.body) return c.json({ error: "no file" }, 400);
    const info = await deps.desktop.saveInstaller(c.req.raw.body, { ...meta, commit: meta.commit ?? null }, deps.installerMaxBytes);
    console.log(`[desktop] installer ${info.filename} (${info.version}, ${info.size} bytes) uploaded`);
    return c.json(info, 201);
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
    const device = await deps.desktop.approve(c.req.param("code"), p.kind === "user" ? p.user.id : null);
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
