import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  AgentRun,
  Capability,
  Event,
  Job,
  JobStatus,
  NewEvent,
  Policy,
  Proposal,
  ProposalStatus,
  RunStatus,
  Task,
  TaskStatus,
  TriageResult,
  WorkerNode,
} from "@cc/core";
import type { OdooCheckpoint } from "@cc/odoo";
import type { NewScheduledPost, ScheduledPost, ScheduledPostStatus } from "@cc/social";
import type { Pool } from "./pool";

type Row = Record<string, any>;
const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

const toEvent = (r: Row): Event => ({
  id: r.id,
  source: r.source,
  vertical: r.vertical,
  kind: r.kind,
  title: r.title,
  payload: r.payload,
  dedupeKey: r.dedupe_key,
  receivedAt: iso(r.received_at)!,
});

const toTask = (r: Row): Task => ({
  id: r.id,
  eventId: r.event_id,
  vertical: r.vertical,
  intent: r.intent,
  route: r.route,
  urgency: r.urgency,
  status: r.status,
  prompt: r.prompt,
  note: r.note ?? null,
  duplicateOf: r.duplicate_of ?? null,
  role: r.role ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toRun = (r: Row): AgentRun => ({
  id: r.id,
  taskId: r.task_id,
  runner: r.runner,
  status: r.status,
  result: r.result,
  error: r.error,
  costUsd: r.cost_usd,
  sessionId: r.session_id,
  startedAt: iso(r.started_at)!,
  finishedAt: iso(r.finished_at),
});

const toProposal = (r: Row): Proposal => ({
  id: r.id,
  taskId: r.task_id,
  vertical: r.vertical,
  actionType: r.action_type,
  summary: r.summary,
  payload: r.payload,
  policy: r.policy,
  status: r.status,
  result: r.result,
  createdAt: iso(r.created_at)!,
  decidedAt: iso(r.decided_at),
});

const toNode = (r: Row): WorkerNode => ({
  id: r.id,
  name: r.name,
  capabilities: r.capabilities,
  online: r.online,
  lastSeen: iso(r.last_seen)!,
});

const toJob = (r: Row): Job => ({
  id: r.id,
  kind: r.kind,
  requires: r.requires,
  payload: r.payload,
  status: r.status,
  nodeId: r.node_id,
  progress: r.progress,
  result: r.result,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toScheduledPost = (r: Row): ScheduledPost => ({
  id: r.id,
  campaignId: r.campaign_id,
  title: r.title,
  accountId: r.account_id,
  platform: r.platform,
  vertical: r.vertical,
  content: r.content,
  publishAt: iso(r.publish_at)!,
  status: r.status,
  result: r.result,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

/** All SQL lives here; the rest of the server talks in domain types. */
export class Store {
  constructor(readonly pool: Pool) {}

  /**
   * Runs `fn` in one transaction, handing it a Store bound to the transaction's
   * connection. Only single-query methods may be used on it (not `claimTaskRun`
   * or `transaction`, which take their own connection).
   */
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await fn(new Store(client as unknown as Pool));
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Events

  /** Inserts an event; returns null when its dedupe key was already seen. */
  async insertEvent(e: NewEvent & { payload: Record<string, unknown> }): Promise<Event | null> {
    const { rows } = await this.pool.query(
      `insert into events (id, source, vertical, kind, title, payload, dedupe_key)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (dedupe_key) do nothing
       returning *`,
      [randomUUID(), e.source, e.vertical ?? null, e.kind, e.title, e.payload, e.dedupeKey ?? null],
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async listEvents(limit = 50): Promise<Event[]> {
    const { rows } = await this.pool.query("select * from events order by received_at desc limit $1", [limit]);
    return rows.map(toEvent);
  }

  async getEvent(id: string): Promise<Event | null> {
    const { rows } = await this.pool.query("select * from events where id = $1", [id]);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  /** The event with this dedupe key, row-locked until the end of the transaction (use inside `transaction`). */
  async lockEventByDedupeKey(dedupeKey: string): Promise<Event | null> {
    const { rows } = await this.pool.query("select * from events where dedupe_key = $1 for update", [dedupeKey]);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  // Tasks

  async insertTask(t: {
    eventId: string;
    triage: TriageResult;
    status: TaskStatus;
    prompt: string;
    note?: string | null;
    duplicateOf?: string | null;
    role?: string | null;
  }): Promise<Task> {
    const { rows } = await this.pool.query(
      `insert into tasks (id, event_id, vertical, intent, route, urgency, status, prompt, triage, note, duplicate_of, role)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [
        randomUUID(),
        t.eventId,
        t.triage.vertical,
        t.triage.intent,
        t.triage.route,
        t.triage.urgency,
        t.status,
        t.prompt,
        t.triage,
        t.note ?? null,
        t.duplicateOf ?? null,
        t.role ?? null,
      ],
    );
    return toTask(rows[0]!);
  }

  /** The task created for an event, if any. */
  async getTaskForEvent(eventId: string): Promise<Task | null> {
    const { rows } = await this.pool.query("select * from tasks where event_id = $1 order by created_at limit 1", [eventId]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  /** Every queued task, oldest first. */
  async listQueuedTasks(): Promise<Task[]> {
    const { rows } = await this.pool.query("select * from tasks where status = 'queued' order by created_at");
    return rows.map(toTask);
  }

  /** Changes a task's status. The note describes the status, so it is replaced (cleared by default). */
  async setTaskStatus(id: string, status: TaskStatus, note: string | null = null): Promise<Task> {
    const { rows } = await this.pool.query(
      "update tasks set status = $2, note = $3, updated_at = now() where id = $1 returning *",
      [id, status, note],
    );
    if (!rows[0]) throw new Error(`No task ${id}`);
    return toTask(rows[0]);
  }

  /** `setTaskStatus`, only if the task is still in one of `from` (null: it has moved on). */
  /** How many tasks this task handed off that haven't finished yet (queued, running or held by the budget). */
  async openHandoffs(taskId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*)::int as n from tasks t join events e on e.id = t.event_id
       where e.source = 'system' and e.kind = 'handoff' and e.payload->>'fromTaskId' = $1 and t.status in ('queued', 'running', 'deferred')`,
      [taskId],
    );
    return rows[0].n;
  }

  async setTaskStatusIf(id: string, from: TaskStatus[], status: TaskStatus, note: string | null = null): Promise<Task | null> {
    const { rows } = await this.pool.query(
      "update tasks set status = $3, note = $4, updated_at = now() where id = $1 and status = any($2::text[]) returning *",
      [id, from, status, note],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  /**
   * Takes a run slot for a task, allowing at most `max` running tasks per vertical.
   * A per-vertical advisory lock makes the count-then-update atomic across workers
   * and replicas. Running tasks untouched for `staleSeconds` (a crashed run) don't
   * count, and only such a stale run may be claimed again: a fresh one is "gone", so
   * a redelivered job never starts a second concurrent run. Consumes the task's one-off budget override and reports whether it was set.
   */
  async claimTaskRun(
    id: string,
    options: { max: number; staleSeconds: number },
  ): Promise<{ state: "claimed"; task: Task; budgetOverride: boolean } | { state: "busy" } | { state: "gone" }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = (await client.query("select vertical from tasks where id = $1", [id])).rows[0];
      if (!current) {
        await client.query("rollback");
        return { state: "gone" };
      }
      await client.query("select pg_advisory_xact_lock(hashtext('cc:vertical-runs:' || $1))", [current.vertical]);
      const task = (
        await client.query(
          "select *, updated_at <= now() - make_interval(secs => $2) as stale from tasks where id = $1 for update",
          [id, options.staleSeconds],
        )
      ).rows[0];
      if (!task || !(task.status === "queued" || (task.status === "running" && task.stale))) {
        await client.query("rollback");
        return { state: "gone" };
      }
      const { rows: busy } = await client.query(
        `select count(*)::int as n from tasks
         where vertical = $1 and status = 'running' and id <> $2 and updated_at > now() - make_interval(secs => $3)`,
        [task.vertical, id, options.staleSeconds],
      );
      if (busy[0]!.n >= options.max) {
        await client.query("rollback");
        return { state: "busy" };
      }
      const { rows } = await client.query(
        "update tasks set status = 'running', note = null, budget_override = false, updated_at = now() where id = $1 returning *",
        [id],
      );
      await client.query("commit");
      return { state: "claimed", task: toTask(rows[0]!), budgetOverride: task.budget_override };
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Puts a failed or deferred task back in the queue, with a one-off budget override. */
  async requeueForRetry(id: string): Promise<Task | null> {
    const { rows } = await this.pool.query(
      `update tasks set status = 'queued', note = null, budget_override = true, updated_at = now()
       where id = $1 and status in ('failed', 'deferred') returning *`,
      [id],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  /** Re-queues every deferred task (the budget day rolled over). */
  async requeueDeferred(): Promise<Task[]> {
    const { rows } = await this.pool.query(
      "update tasks set status = 'queued', note = null, updated_at = now() where status = 'deferred' returning *",
    );
    return rows.map(toTask);
  }

  /** The newest task in `statuses` with the same vertical and prompt, created within the window. */
  async findInFlightDuplicate(vertical: string, prompt: string, statuses: TaskStatus[], withinMinutes: number): Promise<Task | null> {
    const { rows } = await this.pool.query(
      `select * from tasks
       where vertical = $1 and md5(prompt) = md5($2) and prompt = $2 and status = any($3::text[])
         and created_at > now() - make_interval(mins => $4)
       order by created_at desc limit 1`,
      [vertical, prompt, statuses, withinMinutes],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  /** Tasks of a vertical whose status last changed within `[start, end)`. */
  async listTasksUpdatedBetween(vertical: string, statuses: TaskStatus[], start: Date, end: Date): Promise<Task[]> {
    const { rows } = await this.pool.query(
      `select * from tasks where vertical = $1 and status = any($2::text[]) and updated_at >= $3 and updated_at < $4
       order by updated_at`,
      [vertical, statuses, start, end],
    );
    return rows.map(toTask);
  }

  async countTasks(vertical: string, status: TaskStatus): Promise<number> {
    const { rows } = await this.pool.query("select count(*)::int as n from tasks where vertical = $1 and status = $2", [vertical, status]);
    return rows[0]!.n;
  }

  async getTask(id: string): Promise<Task | null> {
    const { rows } = await this.pool.query("select * from tasks where id = $1", [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  /**
   * Newest tasks first. `role` narrows to one org role; with `includeUnassigned`
   * (for a vertical's lead) tasks from before roles existed count as that role's.
   */
  async listTasks(
    options: { status?: TaskStatus; limit?: number; vertical?: string; role?: string; includeUnassigned?: boolean } = {},
  ): Promise<Task[]> {
    const { rows } = await this.pool.query(
      `select * from tasks
       where ($1::text is null or status = $1) and ($3::text is null or vertical = $3)
         and ($4::text is null or role = $4 or ($5::boolean and role is null))
       order by created_at desc limit $2`,
      [options.status ?? null, options.limit ?? 50, options.vertical ?? null, options.role ?? null, options.includeUnassigned ?? false],
    );
    return rows.map(toTask);
  }

  /**
   * Per (vertical, role) numbers for the org chart: open tasks and pending
   * proposals now, tasks done and agent cost since `since`.
   * `role` is null for tasks from before roles existed.
   */
  async roleStats(since: Date): Promise<{ vertical: string; role: string | null; open: number; done: number; costUsd: number; pending: number }[]> {
    const { rows } = await this.pool.query(
      `with t as (
         select vertical, role,
           count(*) filter (where status in ('queued', 'running', 'awaiting_approval', 'deferred'))::int as open,
           count(*) filter (where status = 'done' and updated_at >= $1)::int as done
         from tasks group by vertical, role
       ), c as (
         select t.vertical, t.role, coalesce(sum(r.cost_usd), 0)::float as cost
         from agent_runs r join tasks t on t.id = r.task_id where r.started_at >= $1
         group by t.vertical, t.role
       ), p as (
         select t.vertical, t.role, count(*)::int as pending
         from proposals p join tasks t on t.id = p.task_id where p.status = 'pending'
         group by t.vertical, t.role
       ), k as (
         select vertical, role from t union select vertical, role from c union select vertical, role from p
       )
       select k.vertical, k.role, coalesce(t.open, 0) as open, coalesce(t.done, 0) as done,
              coalesce(c.cost, 0)::float as cost, coalesce(p.pending, 0) as pending
       from k
       left join t on t.vertical = k.vertical and t.role is not distinct from k.role
       left join c on c.vertical = k.vertical and c.role is not distinct from k.role
       left join p on p.vertical = k.vertical and p.role is not distinct from k.role`,
      [since],
    );
    return rows.map((r) => ({ vertical: r.vertical, role: r.role, open: r.open, done: r.done, costUsd: r.cost, pending: r.pending }));
  }

  // Agent runs

  async insertRun(taskId: string, runner: string): Promise<AgentRun> {
    const { rows } = await this.pool.query(
      "insert into agent_runs (id, task_id, runner, status) values ($1, $2, $3, 'running') returning *",
      [randomUUID(), taskId, runner],
    );
    return toRun(rows[0]!);
  }

  async finishRun(
    id: string,
    r: { status: RunStatus; result: string | null; error: string | null; costUsd: number | null; sessionId: string | null },
  ): Promise<AgentRun> {
    const { rows } = await this.pool.query(
      `update agent_runs set status = $2, result = $3, error = $4, cost_usd = $5, session_id = $6, finished_at = now()
       where id = $1 returning *`,
      [id, r.status, r.result, r.error, r.costUsd, r.sessionId],
    );
    return toRun(rows[0]!);
  }

  async listRuns(taskId: string): Promise<AgentRun[]> {
    const { rows } = await this.pool.query("select * from agent_runs where task_id = $1 order by started_at", [taskId]);
    return rows.map(toRun);
  }

  async appendRunMessage(runId: string, message: AgentMessage): Promise<void> {
    await this.pool.query("insert into run_messages (run_id, message) values ($1, $2)", [runId, message]);
  }

  async listRunMessages(runId: string): Promise<AgentMessage[]> {
    const { rows } = await this.pool.query("select message from run_messages where run_id = $1 order by id", [runId]);
    return rows.map((r) => r.message);
  }

  /** Total agent cost since a point in time, for budget caps and the dashboard. */
  async costSince(since: Date): Promise<number> {
    const { rows } = await this.pool.query(
      "select coalesce(sum(cost_usd), 0)::float as total from agent_runs where started_at >= $1",
      [since],
    );
    return rows[0]!.total;
  }

  /** Agent cost per vertical for runs started within `[since, until)`. */
  async costByVertical(since: Date, until?: Date): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(
      `select t.vertical, coalesce(sum(r.cost_usd), 0)::float as total
       from agent_runs r join tasks t on t.id = r.task_id
       where r.started_at >= $1 and ($2::timestamptz is null or r.started_at < $2)
       group by t.vertical`,
      [since, until ?? null],
    );
    return Object.fromEntries(rows.map((r) => [r.vertical, r.total]));
  }

  /** Records that a budget alert went out; false if this scope was already alerted that day. */
  async recordBudgetAlert(day: string, scope: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "insert into budget_alerts (day, scope) values ($1, $2) on conflict do nothing",
      [day, scope],
    );
    return rowCount === 1;
  }

  // Proposals

  async insertProposal(p: {
    taskId: string | null;
    vertical: string;
    actionType: string;
    summary: string;
    payload: Record<string, unknown>;
    policy: Policy;
  }): Promise<Proposal> {
    const { rows } = await this.pool.query(
      `insert into proposals (id, task_id, vertical, action_type, summary, payload, policy, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending') returning *`,
      [randomUUID(), p.taskId, p.vertical, p.actionType, p.summary, p.payload, p.policy],
    );
    return toProposal(rows[0]!);
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const { rows } = await this.pool.query("select * from proposals where id = $1", [id]);
    return rows[0] ? toProposal(rows[0]) : null;
  }

  /**
   * Moves a proposal between states atomically. `from` guards against double
   * approval: the update only applies if the proposal is still in that state.
   */
  async transitionProposal(
    id: string,
    from: ProposalStatus[],
    to: ProposalStatus,
    result?: unknown,
  ): Promise<Proposal | null> {
    const { rows } = await this.pool.query(
      `update proposals
       set status = $3,
           result = coalesce($4, result),
           decided_at = case when $3 in ('approved', 'rejected') then now() else decided_at end
       where id = $1 and status = any($2::text[])
       returning *`,
      [id, from, to, result === undefined ? null : JSON.stringify(result)],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }

  /** Replaces a pending proposal's payload (Dave edited it before approving). Null if it is no longer pending. */
  async updateProposalPayload(id: string, payload: Record<string, unknown>): Promise<Proposal | null> {
    const { rows } = await this.pool.query("update proposals set payload = $2 where id = $1 and status = 'pending' returning *", [id, JSON.stringify(payload)]);
    return rows[0] ? toProposal(rows[0]) : null;
  }

  async listProposals(
    options: { status?: ProposalStatus; taskId?: string; vertical?: string; limit?: number } = {},
  ): Promise<Proposal[]> {
    const { rows } = await this.pool.query(
      `select * from proposals
       where ($1::text is null or status = $1) and ($2::uuid is null or task_id = $2) and ($3::text is null or vertical = $3)
       order by created_at desc limit $4`,
      [options.status ?? null, options.taskId ?? null, options.vertical ?? null, options.limit ?? 50],
    );
    return rows.map(toProposal);
  }

  /** Proposals of a vertical and policy that finished (executed or failed) within `[start, end)`. */
  async listProposalsDecidedBetween(vertical: string, policy: Policy, start: Date, end: Date): Promise<Proposal[]> {
    const { rows } = await this.pool.query(
      `select * from proposals
       where vertical = $1 and policy = $2 and status in ('executed', 'failed') and decided_at >= $3 and decided_at < $4
       order by decided_at`,
      [vertical, policy, start, end],
    );
    return rows.map(toProposal);
  }

  // Push subscriptions

  async savePushSubscription(subscription: { endpoint: string }): Promise<void> {
    await this.pool.query(
      `insert into push_subscriptions (endpoint, subscription) values ($1, $2)
       on conflict (endpoint) do update set subscription = excluded.subscription`,
      [subscription.endpoint, subscription],
    );
  }

  async listPushSubscriptions(): Promise<any[]> {
    const { rows } = await this.pool.query("select subscription from push_subscriptions");
    return rows.map((r) => r.subscription);
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    await this.pool.query("delete from push_subscriptions where endpoint = $1", [endpoint]);
  }

  // Worker nodes & jobs

  async upsertNode(n: { id: string; name: string; capabilities: Capability[] }): Promise<WorkerNode> {
    const { rows } = await this.pool.query(
      `insert into worker_nodes (id, name, capabilities, online, last_seen) values ($1, $2, $3, true, now())
       on conflict (id) do update set name = excluded.name, capabilities = excluded.capabilities, online = true, last_seen = now()
       returning *`,
      [n.id, n.name, n.capabilities],
    );
    return toNode(rows[0]!);
  }

  async touchNode(id: string): Promise<void> {
    await this.pool.query("update worker_nodes set last_seen = now() where id = $1", [id]);
  }

  async setNodeOffline(id: string): Promise<WorkerNode | null> {
    const { rows } = await this.pool.query(
      "update worker_nodes set online = false, last_seen = now() where id = $1 returning *",
      [id],
    );
    return rows[0] ? toNode(rows[0]) : null;
  }

  async markAllNodesOffline(): Promise<void> {
    await this.pool.query("update worker_nodes set online = false");
  }

  async listNodes(): Promise<WorkerNode[]> {
    const { rows } = await this.pool.query("select * from worker_nodes order by name");
    return rows.map(toNode);
  }

  async insertJob(j: { kind: string; requires: Capability[]; payload: Record<string, unknown> }): Promise<Job> {
    const { rows } = await this.pool.query(
      "insert into jobs (id, kind, requires, payload, status) values ($1, $2, $3, $4, 'queued') returning *",
      [randomUUID(), j.kind, j.requires, j.payload],
    );
    return toJob(rows[0]!);
  }

  async listJobs(options: { status?: JobStatus; limit?: number } = {}): Promise<Job[]> {
    const { rows } = await this.pool.query(
      "select * from jobs where ($1::text is null or status = $1) order by created_at desc limit $2",
      [options.status ?? null, options.limit ?? 50],
    );
    return rows.map(toJob);
  }

  /** Jobs updated within `[start, end)`. */
  async listJobsUpdatedBetween(start: Date, end: Date): Promise<Job[]> {
    const { rows } = await this.pool.query(
      "select * from jobs where updated_at >= $1 and updated_at < $2 order by updated_at",
      [start, end],
    );
    return rows.map(toJob);
  }

  /**
   * Assigns the oldest queued job this node can run, if the node is idle.
   * Uses skip-locked so two dispatchers never hand out the same job.
   */
  async claimJobForNode(nodeId: string, capabilities: Capability[]): Promise<Job | null> {
    const { rows } = await this.pool.query(
      `update jobs set status = 'assigned', node_id = $1, updated_at = now()
       where id = (
         select id from jobs
         where status = 'queued' and requires <@ $2::text[]
           and not exists (select 1 from jobs busy where busy.node_id = $1 and busy.status in ('assigned', 'running'))
         order by created_at
         for update skip locked
         limit 1
       )
       returning *`,
      [nodeId, capabilities],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async updateJob(
    id: string,
    nodeId: string,
    patch: { status: JobStatus; progress?: number; result?: unknown },
  ): Promise<Job | null> {
    const { rows } = await this.pool.query(
      `update jobs set status = $3, progress = coalesce($4, progress), result = coalesce($5, result), updated_at = now()
       where id = $1 and node_id = $2 and status in ('assigned', 'running') returning *`,
      [id, nodeId, patch.status, patch.progress ?? null, patch.result === undefined ? null : JSON.stringify(patch.result)],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  /** Puts a disconnected node's unfinished jobs back on the queue. */
  async requeueJobsForNode(nodeId: string): Promise<Job[]> {
    const { rows } = await this.pool.query(
      `update jobs set status = 'queued', node_id = null, progress = null, updated_at = now()
       where node_id = $1 and status in ('assigned', 'running') returning *`,
      [nodeId],
    );
    return rows.map(toJob);
  }

  // Email checkpoints (implements EmailCheckpointStore from @cc/email)

  async getEmailCheckpoint(accountId: string): Promise<{ uidValidity: string; lastUid: number } | null> {
    const { rows } = await this.pool.query("select * from email_checkpoints where account_id = $1", [accountId]);
    return rows[0] ? { uidValidity: rows[0].uid_validity, lastUid: Number(rows[0].last_uid) } : null;
  }

  async saveEmailCheckpoint(accountId: string, c: { uidValidity: string; lastUid: number }): Promise<void> {
    await this.pool.query(
      `insert into email_checkpoints (account_id, uid_validity, last_uid) values ($1, $2, $3)
       on conflict (account_id) do update set uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, updated_at = now()`,
      [accountId, c.uidValidity, c.lastUid],
    );
  }

  // Social (implements SocialCheckpointStore and ScheduledPostStore from @cc/social)

  async getSocialCheckpoint(accountId: string): Promise<string | null> {
    const { rows } = await this.pool.query("select cursor from social_checkpoints where account_id = $1", [accountId]);
    return rows[0]?.cursor ?? null;
  }

  async saveSocialCheckpoint(accountId: string, cursor: string | null): Promise<void> {
    await this.pool.query(
      `insert into social_checkpoints (account_id, cursor) values ($1, $2)
       on conflict (account_id) do update set cursor = excluded.cursor, updated_at = now()`,
      [accountId, cursor],
    );
  }

  /** Recent social events, each with its task's id and status. */
  async listSocialEvents(limit = 50): Promise<(Event & { taskId: string | null; taskStatus: TaskStatus | null })[]> {
    const { rows } = await this.pool.query(
      `select e.*, t.id as task_id, t.status as task_status from events e
       left join lateral (select id, status from tasks where event_id = e.id order by created_at limit 1) t on true
       where e.source = 'social' order by e.received_at desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({ ...toEvent(r), taskId: r.task_id ?? null, taskStatus: r.task_status ?? null }));
  }

  async insertScheduledPosts(posts: NewScheduledPost[]): Promise<ScheduledPost[]> {
    if (!posts.length) return [];
    const { rows } = await this.pool.query(
      `insert into scheduled_posts (id, campaign_id, title, account_id, platform, vertical, content, publish_at, status)
       select * , 'scheduled' from unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::jsonb[], $8::timestamptz[])
       returning *`,
      [
        posts.map(() => randomUUID()),
        posts.map((p) => p.campaignId),
        posts.map((p) => p.title),
        posts.map((p) => p.accountId),
        posts.map((p) => p.platform),
        posts.map((p) => p.vertical),
        posts.map((p) => JSON.stringify(p.content)),
        posts.map((p) => p.publishAt),
      ],
    );
    return rows.map(toScheduledPost);
  }

  /** Moves due posts to `publishing` (skip-locked, so two servers never take the same post). */
  async claimDueScheduledPosts(now: Date, limit: number): Promise<ScheduledPost[]> {
    const { rows } = await this.pool.query(
      `update scheduled_posts set status = 'publishing', updated_at = now()
       where id in (
         select id from scheduled_posts where status = 'scheduled' and publish_at <= $1
         order by publish_at for update skip locked limit $2
       ) returning *`,
      [now, limit],
    );
    return rows.map(toScheduledPost).sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  }

  async finishScheduledPost(id: string, status: "published" | "failed", result: unknown): Promise<void> {
    await this.pool.query(
      "update scheduled_posts set status = $2, result = $3, updated_at = now() where id = $1 and status = 'publishing'",
      [id, status, JSON.stringify(result)],
    );
  }

  async failStaleScheduledPosts(olderThan: Date, result: unknown): Promise<ScheduledPost[]> {
    const { rows } = await this.pool.query(
      `update scheduled_posts set status = 'failed', result = $2, updated_at = now()
       where status = 'publishing' and updated_at < $1 returning *`,
      [olderThan, JSON.stringify(result)],
    );
    return rows.map(toScheduledPost);
  }

  /** Upcoming posts first (soonest first), then the rest, newest first. */
  async listScheduledPosts(options: { status?: ScheduledPostStatus; limit?: number } = {}): Promise<ScheduledPost[]> {
    const { rows } = await this.pool.query(
      `select * from scheduled_posts where ($1::text is null or status = $1)
       order by (status in ('scheduled', 'publishing')) desc,
         case when status in ('scheduled', 'publishing') then publish_at end asc,
         publish_at desc
       limit $2`,
      [options.status ?? null, options.limit ?? 100],
    );
    return rows.map(toScheduledPost);
  }

  async getScheduledPost(id: string): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query("select * from scheduled_posts where id = $1", [id]);
    return rows[0] ? toScheduledPost(rows[0]) : null;
  }

  /** Cancels a post that hasn't started publishing; null otherwise. */
  async cancelScheduledPost(id: string): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query(
      "update scheduled_posts set status = 'cancelled', updated_at = now() where id = $1 and status = 'scheduled' returning *",
      [id],
    );
    return rows[0] ? toScheduledPost(rows[0]) : null;
  }

  // --- Odoo events (implements OdooCheckpointStore from @cc/odoo) ---

  async getOdooCheckpoint(key: string): Promise<OdooCheckpoint | null> {
    const { rows } = await this.pool.query("select cursor, seen_ids, state from odoo_event_checkpoints where source = $1", [key]);
    return rows[0] ? { cursor: rows[0].cursor ?? null, seenIds: rows[0].seen_ids ?? [], state: rows[0].state ?? {} } : null;
  }

  async saveOdooCheckpoint(key: string, c: OdooCheckpoint): Promise<void> {
    await this.pool.query(
      `insert into odoo_event_checkpoints (source, cursor, seen_ids, state) values ($1, $2, $3, $4)
       on conflict (source) do update set cursor = excluded.cursor, seen_ids = excluded.seen_ids, state = excluded.state, updated_at = now()`,
      [key, c.cursor, c.seenIds, JSON.stringify(c.state)],
    );
  }

  /** Odoo events of a vertical received within `[start, end)`, oldest first (for the digest). */
  async listOdooEventsBetween(vertical: string, start: Date, end: Date): Promise<Event[]> {
    const { rows } = await this.pool.query(
      `select * from events where source = 'odoo' and vertical = $1 and received_at >= $2 and received_at < $3 order by received_at`,
      [vertical, start, end],
    );
    return rows.map(toEvent);
  }
  // --- end odoo events ---
}
