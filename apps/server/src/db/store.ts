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

/** All SQL lives here; the rest of the server talks in domain types. */
export class Store {
  constructor(readonly pool: Pool) {}

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

  // Tasks

  async insertTask(t: { eventId: string; triage: TriageResult; status: TaskStatus; prompt: string }): Promise<Task> {
    const { rows } = await this.pool.query(
      `insert into tasks (id, event_id, vertical, intent, route, urgency, status, prompt, triage)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [randomUUID(), t.eventId, t.triage.vertical, t.triage.intent, t.triage.route, t.triage.urgency, t.status, t.prompt, t.triage],
    );
    return toTask(rows[0]!);
  }

  async setTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    const { rows } = await this.pool.query(
      "update tasks set status = $2, updated_at = now() where id = $1 returning *",
      [id, status],
    );
    if (!rows[0]) throw new Error(`No task ${id}`);
    return toTask(rows[0]);
  }

  async getTask(id: string): Promise<Task | null> {
    const { rows } = await this.pool.query("select * from tasks where id = $1", [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async listTasks(options: { status?: TaskStatus; limit?: number } = {}): Promise<Task[]> {
    const { rows } = await this.pool.query(
      `select * from tasks where ($1::text is null or status = $1) order by created_at desc limit $2`,
      [options.status ?? null, options.limit ?? 50],
    );
    return rows.map(toTask);
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

  async listProposals(options: { status?: ProposalStatus; taskId?: string; limit?: number } = {}): Promise<Proposal[]> {
    const { rows } = await this.pool.query(
      `select * from proposals
       where ($1::text is null or status = $1) and ($2::uuid is null or task_id = $2)
       order by created_at desc limit $3`,
      [options.status ?? null, options.taskId ?? null, options.limit ?? 50],
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
}
