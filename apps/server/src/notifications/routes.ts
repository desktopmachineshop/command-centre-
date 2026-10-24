import { NOTIFICATION_CATEGORIES, NotificationCategory, NotificationPriority } from "@cc/core";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { DEFAULT_USER, PrefsPatch } from "./policy";
import type { NotificationService } from "./service";

/**
 * The user a request acts for. Single-user today ("default"); when login
 * sets `userId` on the context, notifications follow it without changes here.
 */
export function userIdOf(c: Context): string {
  const v = (c as unknown as { get(key: string): unknown }).get("userId");
  return typeof v === "string" && v ? v : DEFAULT_USER;
}

/** "iphone" / "android" / "windows" / "mac" / "linux" from a user agent, for the device list. */
export function platformOf(ua: string | undefined): string | null {
  if (!ua) return null;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Linux|CrOS/i.test(ua)) return "linux";
  return null;
}

const Subscription = z
  .object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) })
  .passthrough();

/**
 * /api/notifications: the notification centre, preferences, devices and test
 * pushes. Mounted behind the API's auth check (see http/api.ts).
 */
export function notificationRoutes(service: NotificationService) {
  const app = new Hono();
  const { store } = service;

  app.get("/notifications", async (c) => {
    const q = z
      .object({
        category: NotificationCategory.optional(),
        unread: z.enum(["1", "true", "0", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.iso.datetime().optional(),
      })
      .parse(c.req.query());
    const user = userIdOf(c);
    const [items, unread, byCategory] = await Promise.all([
      store.list(user, {
        category: q.category,
        unread: q.unread === "1" || q.unread === "true",
        limit: q.limit,
        before: q.before ? new Date(q.before) : undefined,
      }),
      store.unreadCount(user),
      store.unreadByCategory(user),
    ]);
    return c.json({ items, unread, unreadByCategory: byCategory });
  });

  app.get("/notifications/unread-count", async (c) => c.json({ unread: await store.unreadCount(userIdOf(c)) }));

  app.post("/notifications/read-all", async (c) => {
    const body = z.object({ category: NotificationCategory.optional() }).parse(await c.req.json().catch(() => ({})));
    const changed = await service.markAllRead(body.category, userIdOf(c));
    return c.json({ changed, unread: await store.unreadCount(userIdOf(c)) });
  });

  app.get("/notifications/prefs", async (c) =>
    c.json({ prefs: await service.prefs(userIdOf(c)), defaults: service.defaults(), categories: NOTIFICATION_CATEGORIES }),
  );
  app.put("/notifications/prefs", async (c) => {
    const patch = PrefsPatch.parse(await c.req.json());
    return c.json({ prefs: await service.updatePrefs(patch, userIdOf(c)) });
  });

  app.get("/notifications/devices", async (c) => c.json({ publicKey: service.publicKey, devices: await store.listDevices(userIdOf(c)) }));
  /** Subscribe this device, with a name. Re-subscribing the same endpoint updates it. */
  app.post("/notifications/devices", async (c) => {
    const body = z
      .object({ subscription: Subscription, name: z.string().trim().max(80).optional(), platform: z.string().max(40).optional() })
      .parse(await c.req.json());
    const ua = c.req.header("user-agent");
    const device = await store.saveDevice(userIdOf(c), {
      subscription: body.subscription,
      name: body.name || null,
      platform: body.platform ?? platformOf(ua),
      userAgent: ua?.slice(0, 300) ?? null,
    });
    return c.json(device, 201);
  });
  app.patch("/notifications/devices/:id", async (c) => {
    const body = z.object({ name: z.string().trim().min(1).max(80).optional(), minPriority: NotificationPriority.optional() }).parse(await c.req.json());
    const device = await store.updateDevice(userIdOf(c), c.req.param("id"), body);
    return device ? c.json(device) : c.json({ error: "not found" }, 404);
  });
  app.delete("/notifications/devices/:id", async (c) =>
    (await store.deleteDevice(userIdOf(c), c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  /** A test push: `{category?}` for one category on every device it routes to, `{deviceId?}` for one device. */
  app.post("/notifications/test", async (c) => {
    const body = z.object({ category: NotificationCategory.optional(), deviceId: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const user = userIdOf(c);
    if (body.deviceId && !(await store.listDevices(user)).some((d) => d.id === body.deviceId)) return c.json({ error: "unknown device" }, 404);
    const n = await service.sendTest({ ...body, userId: user });
    return c.json({ notification: n, pushConfigured: service.publicKey !== null }, 201);
  });

  app.get("/notifications/:id", async (c) => {
    const n = await store.get(userIdOf(c), c.req.param("id"));
    return n ? c.json(n) : c.json({ error: "not found" }, 404);
  });
  app.post("/notifications/:id/read", async (c) => {
    const n = await service.markRead(c.req.param("id"), userIdOf(c));
    return n ? c.json({ notification: n, unread: await store.unreadCount(userIdOf(c)) }) : c.json({ error: "not found" }, 404);
  });

  return app;
}
