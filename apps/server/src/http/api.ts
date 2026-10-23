import type { Brain } from "@cc/brain";
import { Capability, leadOf, ProposalStatus, ROOT_ROLE_ID, TaskStatus } from "@cc/core";
import type { VerticalRegistry } from "@cc/verticals";
import { Hono } from "hono";
import { z } from "zod";
import { authRoutes, type AuthHttpOptions, requireApiAuth } from "../accounts/http";
import type { AuthService } from "../accounts/service";
import { type ActionService, ProposalStateError } from "../actions";
import { tokenMatches } from "../auth";
import type { BudgetService } from "../budget";
import { dayStart, isDay } from "../days";
import type { Store } from "../db/store";
import type { DigestService } from "../digest";
import { buildOrgTree } from "../org";
import type { Pipeline } from "../pipeline";
import type { Notifier } from "../push";
import type { WorkerService } from "../workers";
import { type SocialApiDeps, socialApiRoutes } from "./social";

export interface ApiDeps {
  store: Store;
  pipeline: Pipeline;
  actions: ActionService;
  workers: WorkerService;
  brain: Brain;
  verticals: VerticalRegistry;
  notifier: Notifier;
  budget: BudgetService;
  digests: DigestService;
  adminToken: string;
  webhookSecret?: string;
  /** Social page API and media uploads (see ./social.ts). */
  social?: SocialApiDeps;
  /** Email + password sign-in (src/accounts). */
  auth: { service: AuthService; options: AuthHttpOptions };
}

const limit = z.coerce.number().int().min(1).max(200).default(50);

/** JSON API for the PWA and desktop app. Everything except webhooks and sign-in needs a session cookie or the admin token. */
export function apiRoutes(deps: ApiDeps) {
  const { store, pipeline, actions, workers, brain, verticals } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof ProposalStateError) return c.json({ error: err.message }, 409);
    console.error("[api]", err);
    return c.json({ error: err.message }, 500);
  });

  // Webhook ingress authenticates with its own shared secret, so it sits before the admin check.
  app.post("/ingress/webhook/:vertical", async (c) => {
    if (!deps.webhookSecret || !tokenMatches(c.req.header("x-cc-webhook-secret"), deps.webhookSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const vertical = c.req.param("vertical");
    if (!verticals.get(vertical)) return c.json({ error: `unknown vertical ${vertical}` }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await pipeline.ingest({
      source: "webhook",
      vertical,
      kind: c.req.query("kind") ?? "webhook",
      title: typeof body.title === "string" ? body.title : `Webhook for ${vertical}`,
      payload: body,
      dedupeKey: c.req.header("x-cc-dedupe-key") ?? null,
    });
    return c.json(result ?? { duplicate: true }, result ? 201 : 200);
  });

  // --- auth: /api/auth/* (sign-in, sessions, 2FA), then everything else needs a session cookie OR the admin Bearer token ---
  app.route("/auth", authRoutes(deps.auth.service, deps.auth.options));
  app.use("*", requireApiAuth(deps.auth.service, deps.auth.options));
  // --- end auth ---

  app.get("/verticals", (c) => c.json(verticals.all()));

  app.post("/chat", async (c) => {
    const body = z
      .object({ text: z.string().min(1), vertical: z.string().optional(), role: z.string().optional() })
      .parse(await c.req.json());
    const result = await pipeline.ingest({
      source: "chat",
      vertical: body.vertical ?? null,
      kind: "message",
      title: body.text.slice(0, 120),
      // `role` (optional) asks a specific org role, as a "role: ..." prefix would.
      payload: body.role ? { text: body.text, role: body.role } : { text: body.text },
    });
    return c.json(result, 201);
  });

  app.get("/events", async (c) => c.json(await store.listEvents(limit.parse(c.req.query("limit")))));

  /** `?status=`, plus `?vertical=` and `?role=` (an org role id) to narrow to one role's tasks. */
  app.get("/tasks", async (c) => {
    const status = c.req.query("status") ? TaskStatus.parse(c.req.query("status")) : undefined;
    const role = c.req.query("role") || undefined;
    let vertical = c.req.query("vertical") || undefined;
    if (vertical && !verticals.get(vertical)) return c.json({ error: `unknown vertical ${vertical}` }, 404);
    if (role === ROOT_ROLE_ID) vertical = verticals.rootVertical;
    // Tasks from before roles existed belong to their vertical's lead.
    const includeUnassigned = !!(vertical && role && role !== ROOT_ROLE_ID && leadOf(verticals.require(vertical)).id === role);
    return c.json(await store.listTasks({ status, vertical, role, includeUnassigned, limit: limit.parse(c.req.query("limit")) }));
  });

  // --- org roles (docs/ORG.md) ---
  /** The org chart with live numbers per role over the last 7 days. */
  app.get("/org", async (c) => {
    const windowDays = 7;
    const since = new Date(Date.now() - windowDays * 86_400_000);
    return c.json(buildOrgTree(verticals, await store.roleStats(since), windowDays));
  });
  // --- end org roles ---

  app.get("/tasks/:id", async (c) => {
    const task = await store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const runs = await Promise.all(
      (await store.listRuns(task.id)).map(async (run) => ({ ...run, messages: await store.listRunMessages(run.id) })),
    );
    const event = await store.getEvent(task.eventId);
    const proposals = await store.listProposals({ taskId: task.id });
    return c.json({ task, event, runs, proposals });
  });

  /** Re-runs a failed or deferred task now. An explicit retry ignores the daily budget once. */
  app.post("/tasks/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (!(await store.getTask(id))) return c.json({ error: "not found" }, 404);
    const task = await pipeline.retry(id);
    return task ? c.json(task) : c.json({ error: "only failed or deferred tasks can be retried" }, 409);
  });

  app.get("/proposals", async (c) => {
    const status = c.req.query("status") ? ProposalStatus.parse(c.req.query("status")) : undefined;
    return c.json(await store.listProposals({ status, limit: limit.parse(c.req.query("limit")) }));
  });
  app.post("/proposals/:id/approve", async (c) => c.json(await actions.approve(c.req.param("id"))));
  app.post("/proposals/:id/reject", async (c) => c.json(await actions.reject(c.req.param("id"))));

  app.get("/nodes", async (c) => c.json(await store.listNodes()));
  app.get("/jobs", async (c) => c.json(await store.listJobs({ limit: limit.parse(c.req.query("limit")) })));
  app.post("/jobs", async (c) => {
    const body = z
      .object({ kind: z.string().min(1), requires: z.array(Capability).default([]), payload: z.record(z.string(), z.unknown()).default({}) })
      .parse(await c.req.json());
    return c.json(await workers.submit(body), 201);
  });

  app.get("/brain/search", async (c) => c.json(await brain.search(c.req.query("q") ?? "", { folder: c.req.query("folder") })));
  app.get("/brain/list", async (c) => c.json(await brain.list(c.req.query("folder") ?? "")));
  app.get("/brain/note", async (c) => {
    const note = await brain.read(c.req.query("path") ?? "");
    return note ? c.json(note) : c.json({ error: "not found" }, 404);
  });

  app.get("/stats", async (c) => {
    const { budget } = deps;
    const today = budget.today();
    const pending = await store.listProposals({ status: "pending", limit: 200 });
    return c.json({
      day: today,
      costTodayUsd: await store.costSince(dayStart(today, budget.options.timezone)),
      costTodayByVertical: await budget.spentToday(),
      budgets: budget.limits(),
      pendingApprovals: pending.length,
    });
  });

  /** Deterministic daily digest: `?date=YYYY-MM-DD` (default today), `?vertical=` to narrow it to one. */
  app.get("/digest", async (c) => {
    const date = c.req.query("date") || deps.digests.today();
    if (!isDay(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    const vertical = c.req.query("vertical");
    if (vertical && !verticals.get(vertical)) return c.json({ error: `unknown vertical ${vertical}` }, 404);
    return c.json(await deps.digests.buildAll(date, { only: vertical }));
  });

  app.get("/push/key", (c) => c.json({ publicKey: deps.notifier.publicKey }));
  app.post("/push/subscribe", async (c) => {
    const sub = z
      .object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) })
      .passthrough()
      .parse(await c.req.json());
    await store.savePushSubscription(sub);
    return c.json({ ok: true }, 201);
  });

  // /social/* and /media, behind the admin check above.
  if (deps.social) app.route("/", socialApiRoutes(deps.social));

  return app;
}
