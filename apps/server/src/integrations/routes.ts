import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ClaudeSetup, ClaudeSetupError } from "./claude-setup";
import { IntegrationError, type IntegrationService } from "./service";

/** Who changed it, for the audit log: the signed-in user's email, or "admin token". */
export function actorOf(c: Context): string {
  const p = c.get("principal");
  return p?.kind === "user" ? p.user.email : "admin token";
}

/** Credentials and settings are small; refuse anything bigger before parsing it. */
export const integrationBodyLimit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "too large" }, 413) });

const Patch = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string().max(8192).nullable()).optional(),
});

/** /integrations/*: the Accounts page. Mounted behind /api's auth; responses never contain secrets. */
export function integrationRoutes(service: IntegrationService, claudeSetup?: ClaudeSetup) {
  const app = new Hono();
  app.use("/integrations/*", integrationBodyLimit);
  app.onError((err, c) => {
    if (err instanceof IntegrationError) return c.json({ error: err.message, fields: err.fields }, err.status);
    if (err instanceof ClaudeSetupError) return c.json({ error: err.message }, 400);
    throw err;
  });

  app.get("/integrations", async (c) => c.json(await service.list()));

  // "Connect Claude": the server runs `claude setup-token`; the token goes straight into the Claude entry.
  if (claudeSetup) {
    app.post("/integrations/claude/setup", async (c) => c.json(await claudeSetup.start()));
    app.post("/integrations/claude/setup/:setupId/code", async (c) => {
      const { code } = z.object({ code: z.string().min(1).max(2048) }).parse(await c.req.json());
      const oauthToken = await claudeSetup.finish(c.req.param("setupId"), code);
      const result = await service.save("claude", "default", { data: { runner: "claude-code" }, secrets: { oauthToken } }, actorOf(c), { account: "Claude subscription" });
      return c.json({ ok: true, runner: "claude-code", ...result });
    });
    app.delete("/integrations/claude/setup/:setupId", async (c) => {
      await claudeSetup.cancel(c.req.param("setupId"));
      return c.json({ ok: true });
    });
  }

  const save = async (c: Context) => {
    const patch = Patch.parse(await c.req.json());
    const result = await service.save(c.req.param("kind")!, c.req.param("id") ?? "default", patch, actorOf(c));
    return c.json({ ok: true, ...result });
  };
  app.put("/integrations/:kind", save);
  app.put("/integrations/:kind/:id", save);

  app.post("/integrations/:kind/:id/test", async (c) => c.json(await service.test(c.req.param("kind"), c.req.param("id"))));
  app.post("/integrations/:kind/:id/import", async (c) => c.json({ ok: true, ...(await service.importFromRailway(c.req.param("kind"), c.req.param("id"), actorOf(c))) }));
  app.delete("/integrations/:kind/:id", async (c) => c.json({ ok: true, ...(await service.remove(c.req.param("kind"), c.req.param("id"), actorOf(c))) }));

  return app;
}
