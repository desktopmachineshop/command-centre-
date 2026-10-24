import { createHmac, timingSafeEqual } from "node:crypto";
import {
  addReminder,
  buildToday,
  type CalendarService,
  isDate,
  type PgPaStore,
  RecurrenceError,
  snoozeUntil,
} from "@cc/pa";
import { Hono } from "hono";
import { z } from "zod";

export interface PaApiDeps {
  store: PgPaStore;
  calendar: CalendarService | null;
  timeZone: string;
  /** Signs reminder notification buttons; derived from the admin token. */
  signingSecret: string;
  now?: () => Date;
}

/** HMAC for a reminder notification button, so the service worker can act without the admin token. */
export function signReminderAction(secret: string, id: string, action: string): string {
  return createHmac("sha256", secret).update(`pa-reminder:${id}:${action}`).digest("base64url");
}

/**
 * A reminder push's buttons ("Done", "Snooze 1h") and their pre-signed links in
 * `data.actionUrls`, which the service worker POSTs to (sw-notify.js `backgroundAction`).
 */
export function reminderPushActions(secret: string, id: string) {
  const link = (action: string) => `/api/pa/reminders/${id}/push/${action}?sig=${signReminderAction(secret, id, action)}`;
  return {
    actions: [
      { action: "done", title: "Done" },
      { action: "snooze", title: "Snooze 1h" },
    ],
    data: { reminderId: id, actionUrls: { done: link("done"), snooze: link("snooze") } },
  };
}

/** The PA calendar as the spoken briefing's calendar: the next events from now, declined ones left out. */
export function paVoiceCalendar(calendar: CalendarService) {
  return {
    async upcoming({ now, limit }: { now: Date; limit: number }) {
      const { events } = await calendar.listEvents(now, new Date(now.getTime() + 36 * 3_600_000), { vertical: "personal" });
      return events
        .filter((e) => e.response !== "declined" && (e.allDay || new Date(e.end) > now))
        .slice(0, limit)
        .map((e) => ({
          title: e.title,
          start: e.allDay ? new Date(`${e.start}T00:00:00Z`).toISOString() : e.start,
          allDay: e.allDay,
          ...(e.location ? { location: e.location } : {}),
        }));
    },
  };
}

const sigOk = (secret: string, id: string, action: string, sig: string | undefined) => {
  if (!sig) return false;
  const want = Buffer.from(signReminderAction(secret, id, action));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
};

/** Before the admin check: notification buttons, authorised by their signature alone. */
export function paPushRoutes(deps: PaApiDeps) {
  const app = new Hono();
  app.post("/pa/reminders/:id/push/:action", async (c) => {
    const { id, action } = c.req.param();
    if (!["done", "snooze"].includes(action) || !sigOk(deps.signingSecret, id, action, c.req.query("sig"))) return c.json({ error: "unauthorized" }, 401);
    const now = deps.now?.() ?? new Date();
    const r = action === "done" ? await deps.store.completeReminder(id) : await deps.store.snoozeReminder(id, snoozeUntil("1h", now, deps.timeZone));
    return r ? c.json(r) : c.json({ error: "reminder is not open" }, 409);
  });
  return app;
}

const Vertical = z.string().min(1).default("personal");
const ItemInput = z.object({ text: z.string().trim().min(1).max(500), due: z.string().refine(isDate, "YYYY-MM-DD").nullable().optional() });

/** Admin API for the Today page (mounted under /api after the admin check). */
export function paApiRoutes(deps: PaApiDeps) {
  const { store, calendar, timeZone } = deps;
  const now = () => deps.now?.() ?? new Date();
  const app = new Hono();
  const notFound = { error: "not found" };

  app.get("/pa/today", async (c) => {
    const day = c.req.query("day");
    if (day && !isDate(day)) return c.json({ error: "day must be YYYY-MM-DD" }, 400);
    return c.json({ ...(await buildToday({ store, calendar, timeZone }, { day, now: now() })), accounts: calendar?.publicAccounts() ?? [] });
  });

  // --- Reminders ---
  app.get("/pa/reminders", async (c) => {
    const status = z.enum(["open", "done", "all"]).default("open").parse(c.req.query("status") || undefined);
    const statuses = status === "open" ? (["pending", "sent"] as const) : status === "done" ? (["done"] as const) : (["pending", "sent", "done", "cancelled"] as const);
    return c.json(await store.listReminders({ statuses: [...statuses], vertical: c.req.query("vertical") || undefined }));
  });
  app.post("/pa/reminders", async (c) => {
    const body = z.object({ text: z.string().min(1), due: z.string().min(1), recurrence: z.string().nullable().optional(), vertical: Vertical }).parse(await c.req.json());
    try {
      return c.json(await addReminder(store, body, { vertical: body.vertical, createdBy: "dave", timeZone, now: now() }), 201);
    } catch (err) {
      if (err instanceof RecurrenceError || /date-time|empty/.test((err as Error).message)) return c.json({ error: (err as Error).message }, 400);
      throw err;
    }
  });
  app.post("/pa/reminders/:id/complete", async (c) => {
    const r = await store.completeReminder(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "reminder is not open" }, 409);
  });
  app.post("/pa/reminders/:id/snooze", async (c) => {
    const body = z.object({ minutes: z.number().int().positive().max(60 * 24 * 60).optional(), until: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const until = body.until ? snoozeUntil(body.until, now(), timeZone) : snoozeUntil(body.minutes ?? 60, now(), timeZone);
    if (until <= now()) return c.json({ error: "snooze must end in the future" }, 400);
    const r = await store.snoozeReminder(c.req.param("id"), until);
    return r ? c.json(r) : c.json({ error: "reminder is not open" }, 409);
  });
  app.delete("/pa/reminders/:id", async (c) => {
    const r = await store.cancelReminder(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "reminder is not open" }, 409);
  });

  // --- Lists ---
  app.get("/pa/lists", async (c) => c.json(await store.listLists(c.req.query("vertical") || undefined)));
  app.post("/pa/lists", async (c) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), vertical: Vertical }).parse(await c.req.json());
    return c.json(await store.ensureList(body.vertical, body.name), 201);
  });
  app.post("/pa/lists/reorder", async (c) => {
    await store.reorderLists(z.object({ ids: z.array(z.string()) }).parse(await c.req.json()).ids);
    return c.json({ ok: true });
  });
  app.patch("/pa/lists/:id", async (c) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
    try {
      const list = await store.renameList(c.req.param("id"), name);
      return list ? c.json(list) : c.json(notFound, 404);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return c.json({ error: `a list called ${name} already exists` }, 409);
      throw err;
    }
  });
  app.delete("/pa/lists/:id", async (c) => ((await store.deleteList(c.req.param("id"))) ? c.json({ ok: true }) : c.json(notFound, 404)));
  app.get("/pa/lists/:id/items", async (c) => {
    const list = await store.getList(c.req.param("id"));
    if (!list) return c.json(notFound, 404);
    return c.json(await store.listItems(list.id, { includeDone: c.req.query("done") !== "0" }));
  });
  app.post("/pa/lists/:id/items", async (c) => {
    const list = await store.getList(c.req.param("id"));
    if (!list) return c.json(notFound, 404);
    const raw = await c.req.json();
    const items = z.array(ItemInput).min(1).max(100).parse(Array.isArray(raw?.items) ? raw.items : [raw]);
    return c.json(await store.addItems(list.id, items.map((i) => ({ text: i.text, dueDate: i.due ?? null })), "dave"), 201);
  });
  app.post("/pa/lists/:id/reorder", async (c) => {
    await store.reorderItems(c.req.param("id"), z.object({ ids: z.array(z.string()) }).parse(await c.req.json()).ids);
    return c.json({ ok: true });
  });
  app.patch("/pa/items/:id", async (c) => {
    const body = z
      .object({ text: z.string().trim().min(1).max(500).optional(), due: z.string().refine(isDate, "YYYY-MM-DD").nullable().optional(), done: z.boolean().optional() })
      .parse(await c.req.json());
    const id = c.req.param("id");
    if (!(await store.getItem(id))) return c.json(notFound, 404);
    if (body.text !== undefined || body.due !== undefined) await store.updateItem(id, { text: body.text, dueDate: body.due });
    if (body.done !== undefined) await store.setItemDone(id, body.done);
    return c.json(await store.getItem(id));
  });
  app.delete("/pa/items/:id", async (c) => ((await store.deleteItem(c.req.param("id"))) ? c.json({ ok: true }) : c.json(notFound, 404)));

  return app;
}
