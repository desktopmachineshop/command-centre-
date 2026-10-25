import { type Context, Hono } from "hono";
import { z } from "zod";
import { IntegrationError, type IntegrationService } from "./service";

/** Who changed it, for the audit log: the signed-in user's email, or "admin token". */
export function actorOf(c: Context): string {
  const p = c.get("principal");
  return p?.kind === "user" ? p.user.email : "admin token";
}

const Patch = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string().max(8192).nullable()).optional(),
});

/** /integrations/*: the Accounts page. Mounted behind /api's auth; responses never contain secrets. */
export function integrationRoutes(service: IntegrationService) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof IntegrationError) return c.json({ error: err.message, fields: err.fields }, err.status);
    throw err;
  });

  app.get("/integrations", async (c) => c.json(await service.list()));

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
