import { BrainConflictError, parseNote, type PgBrain, serializeNote } from "@cc/brain";
import { Capability, leadOf, ProposalStatus, ROOT_ROLE_ID, SetupRoleId, TaskStatus } from "@cc/core";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { authRoutes, type AuthHttpOptions, requireApiAuth } from "../accounts/http";
import type { AuthService } from "../accounts/service";
import { type ActionService, ProposalInvalidError, ProposalStateError } from "../actions";
import { ReplyStateError } from "../voice/conversations";
import { tokenMatches } from "../auth";
import type { BudgetService } from "../budget";
import { ChatFileError, ChatFileIds, chatFileRoutes, type ChatFiles } from "../chat-files";
import { dayStart, isDay } from "../days";
import type { Store } from "../db/store";
import type { DigestService } from "../digest";
import { buildOrgTree } from "../org";
import { OrgConflictError, type OrgConfigService } from "../org-config";
import { OrgError, type VerticalRegistry } from "@cc/verticals";
import { notificationRoutes } from "../notifications/routes";
import type { NotificationService } from "../notifications/service";
import type { Pipeline } from "../pipeline";
import type { Notifier } from "../push";
import { SetupError, type WorkerService } from "../workers";
import { type IntegrationService, integrationRoutes } from "../integrations";
import type { ClaudeSetup } from "../integrations/claude-setup";
import { type PaApiDeps, paApiRoutes, paPushRoutes } from "./pa";
import { type SocialApiDeps, socialApiRoutes } from "./social";
import { type StorageApiDeps, storageApiRoutes } from "./storage";
import { type VoiceApiDeps, voiceApiRoutes } from "./voice";
import { type DesktopApiDeps, desktopApiRoutes } from "./desktop";

export interface ApiDeps {
  store: Store;
  pipeline: Pipeline;
  actions: ActionService;
  workers: WorkerService;
  brain: PgBrain;
  verticals: VerticalRegistry;
  notifier: Notifier;
  budget: BudgetService;
  digests: DigestService;
  adminToken: string;
  webhookSecret?: string;
  /** Social page API and media uploads (see ./social.ts). */
  social?: SocialApiDeps;
  /** /storage: direct uploads, file list, migration (see ./storage.ts). */
  storage?: StorageApiDeps;
  /** Email + password sign-in (src/accounts). */
  auth: { service: AuthService; options: AuthHttpOptions };
  /** Drive mode: speech, briefing, approvals by voice, task replies (see ./voice.ts). */
  voice?: VoiceApiDeps;
  /** Notification centre, preferences and devices (see ../notifications/routes.ts). */
  notifications?: NotificationService;
  /** Today page API and reminder notification buttons (see ./pa.ts). */
  pa?: PaApiDeps;
  /** Accounts page: platform credentials (see ../integrations). */
  integrations?: IntegrationService;
  /** "Connect Claude" (runs `claude setup-token` on the server). */
  claudeSetup?: ClaudeSetup;
  /** Org page editing: roles and policies over the code manifests (see ../org-config.ts). */
  org?: OrgConfigService;
  /** Desktop app: approving a computer's link, linked computers, installer download (see ./desktop.ts). */
  desktop?: DesktopApiDeps;
  /** Files pasted, dropped or attached in the chat box (see ../chat-files.ts). */
  chatFiles?: ChatFiles;
}

const limit = z.coerce.number().int().min(1).max(200).default(50);

/** JSON API for the PWA and desktop app. Everything except webhooks and sign-in needs a session cookie or the admin token. */
export function apiRoutes(deps: ApiDeps) {
  const { store, pipeline, actions, workers, brain, verticals } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof ProposalStateError) return c.json({ error: err.message }, 409);
    if (err instanceof ProposalInvalidError) return c.json({ error: err.message }, 400);
    if (err instanceof ReplyStateError) return c.json({ error: err.message }, 409);
    if (err instanceof ChatFileError) return c.json({ error: err.message }, 400);
    if (err instanceof BrainConflictError) return c.json({ error: err.message, version: err.currentVersion }, 409);
    if (err instanceof OrgConflictError) return c.json({ error: err.message, version: err.currentVersion }, 409);
    if (err instanceof OrgError) return c.json({ error: err.message, issues: err.issues }, 400);
    if (/^(Path outside brain|Brain notes must be \.md)/.test(err.message)) return c.json({ error: err.message }, 400);
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

  // Reminder notification buttons carry their own signature, so they sit before the admin check too.
  if (deps.pa) app.route("/", paPushRoutes(deps.pa));

  // --- auth: /api/auth/* (sign-in, sessions, 2FA), then everything else needs a session cookie OR the admin Bearer token ---
  app.route("/auth", authRoutes(deps.auth.service, deps.auth.options));
  app.use("*", requireApiAuth(deps.auth.service, deps.auth.options));
  // --- end auth ---

  app.get("/verticals", (c) => c.json(verticals.all()));

  app.post("/chat", async (c) => {
    // `role` (optional) asks a specific org role, as a "role: ..." prefix would.
    // `voice: true` (Drive mode) asks the agent for a short spoken answer; see agent-context voicePrompt.
    // `files` (optional): ids from POST /chat/files, handed to the agent with the message (../chat-files.ts).
    const body = z
      .object({ text: z.string().min(1), vertical: z.string().optional(), role: z.string().optional(), voice: z.boolean().optional(), files: ChatFileIds.optional() })
      .parse(await c.req.json());
    if (body.files?.length && !deps.chatFiles) return c.json({ error: "file attachments are not available on this server" }, 400);
    const attached = body.files?.length && deps.chatFiles ? await deps.chatFiles.context(body.files) : null;
    const result = await pipeline.ingest({
      source: "chat",
      vertical: body.vertical ?? null,
      kind: "message",
      title: body.text.slice(0, 120),
      payload: {
        text: body.text,
        ...(body.role ? { role: body.role } : {}),
        ...(body.voice ? { voice: true } : {}),
        ...(attached ? { files: attached.files, filesPrompt: attached.prompt } : {}),
      },
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

  /** Who made a change from the app, for brain and org history. */
  const editor = (c: Context) => {
    const p = c.get("principal");
    return p.kind === "user" ? p.user.name || p.user.email : "admin";
  };

  // --- org roles (docs/ORG.md) ---
  /** The org chart with live numbers per role over the last 7 days. */
  app.get("/org", async (c) => {
    const windowDays = 7;
    const since = new Date(Date.now() - windowDays * 86_400_000);
    return c.json(buildOrgTree(verticals, await store.roleStats(since), windowDays));
  });
  // Editing: `:unit` is a vertical id or chief-of-staff. A save sends the whole unit (every role of the vertical
  // and its policies) with the version it started from; the whole org is checked before anything is stored.
  const org = deps.org;
  if (org) {
    app.get("/org/config", async (c) => c.json(await org.config()));
    app.put("/org/config/:unit", async (c) => {
      const body = z.object({ data: z.record(z.string(), z.unknown()), expectedVersion: z.number().int().min(0) }).parse(await c.req.json());
      await org.save(c.req.param("unit"), body.data, { author: editor(c), expectedVersion: body.expectedVersion });
      return c.json(await org.config());
    });
    /** Back to the code manifest. The saved versions are kept, so it can be restored. */
    app.delete("/org/config/:unit", async (c) => {
      const expectedVersion = z.coerce.number().int().min(0).parse(c.req.query("expectedVersion"));
      await org.save(c.req.param("unit"), null, { author: editor(c), expectedVersion });
      return c.json(await org.config());
    });
    app.get("/org/config/:unit/history", async (c) => c.json(await org.history(c.req.param("unit"))));
    app.get("/org/config/:unit/versions/:version", async (c) => {
      const data = await org.readVersion(c.req.param("unit"), z.coerce.number().int().parse(c.req.param("version")));
      return data === undefined ? c.json({ error: "not found" }, 404) : c.json({ data });
    });
    app.post("/org/config/:unit/restore", async (c) => {
      const body = z.object({ version: z.number().int().min(1) }).parse(await c.req.json());
      const ok = await org.restore(c.req.param("unit"), body.version, { author: editor(c) });
      return ok ? c.json(await org.config()) : c.json({ error: "not found" }, 404);
    });
  }
  // --- end org roles ---

  app.get("/tasks/:id", async (c) => {
    const task = await store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const responses = (await deps.voice?.conversations.responses(task.id)) ?? new Map();
    const runs = await Promise.all(
      (await store.listRuns(task.id)).map(async (run) => ({
        ...run,
        response: responses.get(run.id) ?? null,
        messages: await store.listRunMessages(run.id),
      })),
    );
    const event = await store.getEvent(task.eventId);
    const proposals = await store.listProposals({ taskId: task.id });
    return c.json({ task, event, runs, proposals });
  });

  /** The proposals of a task and of everything it handed off: a chat shows them inline. */
  app.get("/tasks/:id/chain-proposals", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success || !(await store.getTask(id.data))) return c.json({ error: "not found" }, 404);
    return c.json(await store.chainProposals(id.data));
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
  /** Dave edits what a pending proposal will do (e.g. the email text) before approving it. */
  app.patch("/proposals/:id", async (c) => {
    const body = z.object({ payload: z.record(z.string(), z.unknown()) }).parse(await c.req.json());
    return c.json(await actions.edit(c.req.param("id"), body.payload));
  });
  /**
   * "Ask for changes": rejects the proposal and sends Dave's feedback to the agent
   * that proposed it, continuing its task so it can propose a revised version.
   */
  app.post("/proposals/:id/revise", async (c) => {
    const { feedback } = z.object({ feedback: z.string().trim().min(1).max(4000) }).parse(await c.req.json());
    const proposal = await store.getProposal(c.req.param("id"));
    if (!proposal || proposal.status !== "pending") return c.json({ error: "proposal is not pending" }, 409);
    const conversations = deps.voice?.conversations;
    if (!proposal.taskId || !conversations) return c.json({ error: "no agent task to send feedback to; reject it instead" }, 409);
    // A run still in progress can't take a reply yet: say so before rejecting anything.
    const owner = await store.getTask(proposal.taskId);
    if (owner?.status === "queued" || owner?.status === "running") return c.json({ error: "the agent is still working on this task; try again when it has finished" }, 409);
    const rejected = await actions.reject(proposal.id);
    const message = [
      `Dave did not approve your proposed ${proposal.actionType} ("${proposal.summary}") and asked for changes:`,
      "",
      feedback,
      "",
      "Revise it and propose it again with propose_action, or explain why you can't.",
    ].join("\n");
    const task = await conversations.reply(proposal.taskId, message, false);
    return c.json({ proposal: rejected, task });
  });

  app.get("/nodes", async (c) => c.json(await store.listNodes()));
  /** Installs what a role (media, claude) is missing on that computer: a setup.install job for it alone. */
  app.post("/nodes/:id/setup", async (c) => {
    const { role } = z.object({ role: SetupRoleId }).parse(await c.req.json().catch(() => ({})));
    try {
      return c.json(await workers.installRole(c.req.param("id"), role), 201);
    } catch (err) {
      if (err instanceof SetupError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
  app.get("/jobs", async (c) => c.json(await store.listJobs({ limit: limit.parse(c.req.query("limit")) })));
  app.post("/jobs", async (c) => {
    const body = z
      .object({ kind: z.string().min(1), requires: z.array(Capability).default([]), payload: z.record(z.string(), z.unknown()).default({}) })
      .parse(await c.req.json());
    return c.json(await workers.submit(body), 201);
  });
  /** Cancels a job no computer has picked up (409 once it has started or finished). */
  app.post("/jobs/:id/cancel", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "not found" }, 404);
    const job = await workers.cancel(id.data);
    if (job) return c.json(job);
    const existing = (await store.listJobs({ limit: 500 })).find((j) => j.id === id.data);
    return existing ? c.json({ error: `The job is ${existing.status}, so it can't be cancelled.` }, 409) : c.json({ error: "not found" }, 404);
  });

  app.get("/brain/search", async (c) => c.json(await brain.search(c.req.query("q") ?? "", { folder: c.req.query("folder") })));
  app.get("/brain/list", async (c) => c.json(await brain.list(c.req.query("folder") ?? "")));
  /** The note plus `raw`: the editable file, without the automatic `updated` key. */
  app.get("/brain/note", async (c) => {
    const note = await brain.read(c.req.query("path") ?? "");
    if (!note) return c.json({ error: "not found" }, 404);
    const { updated: _updated, ...frontmatter } = note.frontmatter;
    return c.json({ ...note, raw: serializeNote({ frontmatter, body: note.body }) });
  });
  // --- brain editing: saves from the app, with history and restore; `expectedVersion` refuses stale saves (409) ---
  /** `raw` is the whole file (YAML frontmatter fence + markdown); `expectedVersion` 0 creates a new note. */
  app.put("/brain/note", async (c) => {
    const body = z
      .object({ path: z.string().min(1), raw: z.string(), expectedVersion: z.number().int().min(0).optional(), message: z.string().optional() })
      .parse(await c.req.json());
    const parsed = parseNote(body.path, body.raw);
    const note = await brain.write(body.path, parsed, { author: editor(c), message: body.message, expectedVersion: body.expectedVersion });
    return c.json(note);
  });
  app.delete("/brain/note", async (c) => {
    const expected = c.req.query("expectedVersion");
    const deleted = await brain.delete(c.req.query("path") ?? "", {
      author: editor(c),
      expectedVersion: expected === undefined ? undefined : z.coerce.number().int().parse(expected),
    });
    return deleted ? c.json({ deleted: true }) : c.json({ error: "not found" }, 404);
  });
  app.get("/brain/history", async (c) => c.json(await brain.history(c.req.query("path") ?? "")));
  app.get("/brain/version", async (c) => {
    const note = await brain.readVersion(c.req.query("path") ?? "", z.coerce.number().int().parse(c.req.query("version")));
    return note ? c.json(note) : c.json({ error: "not found" }, 404);
  });
  app.post("/brain/restore", async (c) => {
    const body = z.object({ path: z.string().min(1), version: z.number().int().min(1) }).parse(await c.req.json());
    const note = await brain.restore(body.path, body.version, { author: editor(c) });
    return note ? c.json(note) : c.json({ error: "not found" }, 404);
  });
  // --- end brain editing ---

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

  // /notifications/*, behind the admin check above.
  if (deps.notifications) app.route("/", notificationRoutes(deps.notifications));

  // /social/* and /media, behind the admin check above.
  if (deps.social) app.route("/", socialApiRoutes(deps.social));
  if (deps.storage) app.route("/", storageApiRoutes(deps.storage)); // storage
  if (deps.chatFiles) app.route("/", chatFileRoutes(deps.chatFiles)); // chat files
  if (deps.desktop) app.route("/", desktopApiRoutes(deps.desktop)); // desktop
  // /voice/* and /tasks/:id/reply, behind the admin check above.
  if (deps.voice) app.route("/", voiceApiRoutes({ ...deps.voice, chatFiles: deps.chatFiles }));
  // /pa/*: the Today page.
  if (deps.pa) app.route("/", paApiRoutes(deps.pa));
  if (deps.integrations) app.route("/", integrationRoutes(deps.integrations, deps.claudeSetup));

  return app;
}
