import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerticalManifest } from "@cc/core";
import { type EmailAccount, emailEvent } from "@cc/email";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgBossTaskQueue } from "../src/queue";
import { prepareWorkspace } from "../src/workspace";
import { DB_URL, makeServer, resetDatabase, WEBHOOK } from "./helpers";

type Ctx = Awaited<ReturnType<typeof makeServer>>;

const account = {
  id: "shop",
  vertical: "dms",
  address: "support@example.com",
  mailbox: "INBOX",
  ignoreFrom: [],
  imap: { host: "h", port: 1, secure: true, user: "u", pass: "p" },
  smtp: { host: "h", port: 1, secure: true, user: "u", pass: "p" },
} as unknown as EmailAccount;

const email = (messageId: string, text: string) =>
  ({
    from: { name: "Jane", address: "jane@example.com" },
    replyTo: [],
    to: [],
    cc: [],
    subject: "Order?",
    date: null,
    messageId,
    inReplyTo: null,
    references: [],
    text,
    quotedHistoryStripped: false,
    truncated: false,
    attachments: [],
  }) as unknown as Parameters<typeof emailEvent>[1];

/** Makes the next call of `obj[key]` throw, then restores it. */
function failOnce<T extends object>(obj: T, key: keyof T & string, message: string) {
  const original = (obj as any)[key];
  (obj as any)[key] = async (...args: unknown[]) => {
    (obj as any)[key] = original;
    throw new Error(message);
  };
}

const truncate = (ctx: Ctx) => ctx.server.store.pool.query("truncate events, tasks, agent_runs, run_messages cascade");

describe.skipIf(!DB_URL)("ingest survives failures part-way (retry with the same dedupe key)", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer();
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(async () => truncate(ctx));

  it("re-enqueues the task when the first enqueue failed", async () => {
    const event = emailEvent(account, email("<m1@example.com>", "where is my order"), "uid:1:5");
    failOnce(ctx.queue, "enqueue", "pg-boss hiccup");
    await expect(ctx.server.pipeline.ingest(event)).rejects.toThrow("hiccup");

    // The email poller retries the same UID after backoff.
    expect(await ctx.server.pipeline.ingest(event)).toBeNull();
    await ctx.queue.drain();
    const tasks = await ctx.server.store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("done");
    expect(await ctx.server.store.listRuns(tasks[0]!.id)).toHaveLength(1);
  });

  it("rolls the event back when triage or the task insert fails, so the retry starts over", async () => {
    const triager = (ctx.server.pipeline as any).deps.triager;
    failOnce(triager, "triage", "triage unavailable");
    const send = () =>
      ctx.server.app.request("/api/ingress/webhook/dms", {
        method: "POST",
        headers: { "x-cc-webhook-secret": WEBHOOK, "x-cc-dedupe-key": "order-42", "content-type": "application/json" },
        body: JSON.stringify({ title: "order 42 paid" }),
      });
    expect((await send()).status).toBe(500);
    expect(await ctx.server.store.listEvents()).toHaveLength(0);

    const retry = await send();
    expect(retry.status).toBe(201);
    await ctx.queue.drain();
    const tasks = await ctx.server.store.listTasks();
    expect(tasks.map((t) => t.status)).toEqual(["done"]);
    // A later redelivery is a plain duplicate.
    expect(await (await send()).json()).toEqual({ duplicate: true });
  });

  it("finishes an event left without a task", async () => {
    const event = emailEvent(account, email("<m2@example.com>", "do you stock ER11 collets?"), "uid:1:6");
    await ctx.server.store.insertEvent(event); // as a crash before the transactional ingest could leave it
    const result = await ctx.server.pipeline.ingest(event);
    expect(result?.task.status).toBe("queued");
    await ctx.queue.drain();
    expect((await ctx.server.store.getTask(result!.task.id))!.status).toBe("done");
    expect(await ctx.server.store.listEvents()).toHaveLength(1);
  });

  it("runs a task once even when it is enqueued twice", async () => {
    const result = await ctx.server.pipeline.ingest({ source: "chat", kind: "message", title: "dms: count spindles", payload: { text: "dms: count spindles" } });
    await ctx.queue.enqueue(result!.task.id);
    await ctx.queue.drain();
    expect((await ctx.server.store.getTask(result!.task.id))!.status).toBe("done");
    expect(await ctx.server.store.listRuns(result!.task.id)).toHaveLength(1);
  });

  it("enqueues queued tasks on boot (crash between commit and enqueue)", async () => {
    failOnce(ctx.queue, "enqueue", "process died");
    const event = { source: "chat" as const, kind: "message", title: "dms: check stock", payload: { text: "dms: check stock" } };
    await expect(ctx.server.pipeline.ingest(event)).rejects.toThrow("process died");
    const [task] = await ctx.server.store.listTasks();
    expect(task!.status).toBe("queued");

    const rebooted = await makeServer();
    try {
      await rebooted.queue.drain();
      expect((await rebooted.server.store.getTask(task!.id))!.status).toBe("done");
    } finally {
      await rebooted.server.stop();
    }
  });
});

describe.skipIf(!DB_URL)("runTask never strands a task in running", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ env: { AGENT_DAILY_BUDGET_USD: "5" } });
  });
  afterAll(async () => ctx?.server.stop());
  beforeEach(async () => truncate(ctx));

  it("fails the task, retryably and with a note, when the budget check throws", async () => {
    failOnce(ctx.server.store, "costByVertical", "connection reset");
    const res = await ctx.server.app.request("/api/ingress/webhook/dms", {
      method: "POST",
      headers: { "x-cc-webhook-secret": WEBHOOK, "content-type": "application/json" },
      body: JSON.stringify({ title: "order" }),
    });
    const { task } = (await res.json()) as { task: { id: string } };
    await ctx.queue.drain();

    const after = (await ctx.api(`/api/tasks/${task.id}`)).body;
    expect(after.task.status).toBe("failed");
    expect(after.task.note).toMatch(/before the agent started: connection reset/);
    expect(after.runs).toHaveLength(0);

    const retry = await ctx.api(`/api/tasks/${task.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    await ctx.queue.drain();
    expect((await ctx.api(`/api/tasks/${task.id}`)).body.task.status).toBe("done");
  });

  it("fails the task with a note when the run itself throws", async () => {
    const runner = (ctx.server.pipeline as any).deps.runner;
    failOnce(runner, "run", "spawn ENOENT");
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: anything" } });
    await ctx.queue.drain();
    const after = (await ctx.api(`/api/tasks/${body.task.id}`)).body;
    expect(after.task).toMatchObject({ status: "failed", note: "Run failed: spawn ENOENT" });
    expect(after.runs[0]).toMatchObject({ status: "failed", error: "spawn ENOENT" });
  });

  it("only re-claims a running task once it is stale", async () => {
    const { body } = await ctx.api("/api/chat", { method: "POST", json: { text: "dms: claim me" } });
    await ctx.queue.drain();
    const { store } = ctx.server;
    await store.setTaskStatus(body.task.id, "running");
    expect((await store.claimTaskRun(body.task.id, { max: 5, staleSeconds: 3600 })).state).toBe("gone");
    await store.pool.query("update tasks set updated_at = now() - interval '2 hours' where id = $1", [body.task.id]);
    expect((await store.claimTaskRun(body.task.id, { max: 5, staleSeconds: 3600 })).state).toBe("claimed");
  });
});

describe.skipIf(!DB_URL)("pg-boss job expiry", () => {
  beforeAll(async () => resetDatabase(DB_URL!));

  it("follows the configured expiry, also for an existing queue", async () => {
    const expiry = async () => {
      const client = new pg.Client({ connectionString: DB_URL });
      await client.connect();
      const { rows } = await client.query("select expire_seconds from pgboss.queue where name = 'agent-task'");
      await client.end();
      return rows[0]?.expire_seconds;
    };
    for (const seconds of [1500, 2100]) {
      const queue = new PgBossTaskQueue(DB_URL!, 1, seconds);
      await queue.start();
      await queue.stop();
      expect(await expiry()).toBe(seconds);
    }
  });
});

describe("prepareWorkspace", () => {
  const vertical = (skills: string[]) => ({ id: "dms", skills }) as unknown as VerticalManifest;
  const setup = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cc-ws-"));
    const skillsDir = join(dataDir, "skills");
    for (const name of ["a", "b", "c"]) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    return { dataDir, skillsDir };
  };

  it("is safe to run concurrently and keeps the links in step with the manifest", async () => {
    const { dataDir, skillsDir } = setup();
    const cwds = await Promise.all(Array.from({ length: 8 }, () => prepareWorkspace(dataDir, skillsDir, vertical(["a", "b"]))));
    const target = join(cwds[0]!, ".claude", "skills");
    expect(readdirSync(target).sort()).toEqual(["a", "b"]);
    expect(readlinkSync(join(target, "a"))).toBe(join(skillsDir, "a"));

    // A skill dropped from the manifest goes; a stray folder is replaced by the link.
    mkdirSync(join(target, "c"));
    await prepareWorkspace(dataDir, skillsDir, vertical(["b", "c"]));
    expect(readdirSync(target).sort()).toEqual(["b", "c"]);
    expect(lstatSync(join(target, "c")).isSymbolicLink()).toBe(true);
  });
});

