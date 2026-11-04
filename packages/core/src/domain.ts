import { z } from "zod";
import { NotificationCategory } from "./notifications";
import { NodeSetup } from "./setup";

/** Where an event entered the system. New ingress adapters add a value here. */
export const EventSource = z.enum(["chat", "cron", "webhook", "email", "odoo", "social", "system"]);
export type EventSource = z.infer<typeof EventSource>;

export const NewEvent = z.object({
  source: EventSource,
  /** Vertical the ingress already knows the event belongs to; triage fills it in otherwise. */
  vertical: z.string().nullish(),
  /** Free-form kind within a source, e.g. "message", "schedule:daily-digest", "order.created". */
  kind: z.string().min(1),
  /** Short human-readable summary shown in the inbox. */
  title: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Optional idempotency key; a second event with the same key is ignored. */
  dedupeKey: z.string().nullish(),
});
export type NewEvent = z.input<typeof NewEvent>;

export const Event = NewEvent.extend({
  id: z.string(),
  vertical: z.string().nullable(),
  dedupeKey: z.string().nullable(),
  receivedAt: z.string(),
});
export type Event = z.infer<typeof Event>;

/**
 * What happens to an event after triage, cheapest first:
 * - drop: ignore (spam, noise)
 * - file: record in the brain, no action
 * - rule: deterministic handler, no LLM
 * - cheap-agent: small/cheap model
 * - agent: full agent run (Claude Code)
 */
export const Route = z.enum(["drop", "file", "rule", "cheap-agent", "agent"]);
export type Route = z.infer<typeof Route>;

export const TriageResult = z.object({
  vertical: z.string(),
  intent: z.string(),
  /** 0 (whenever) .. 1 (now). */
  urgency: z.number().min(0).max(1),
  route: Route,
  /** 0..1 confidence of the triager in this decision. */
  confidence: z.number().min(0).max(1),
  /** Which triager produced the result, e.g. "rules", "jev", "haiku". */
  triager: z.string(),
  notes: z.string().optional(),
  /** Push the event straight away in this notification category (e.g. an incoming RFQ), even when it is only filed. */
  push: NotificationCategory.optional(),
});
export type TriageResult = z.infer<typeof TriageResult>;

/** `deferred`: held back by a daily budget cap; re-queued when the day rolls over or on retry. */
export const TaskStatus = z.enum(["queued", "running", "awaiting_approval", "done", "failed", "dropped", "deferred"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string(),
  eventId: z.string(),
  vertical: z.string(),
  intent: z.string(),
  route: Route,
  urgency: z.number(),
  status: TaskStatus,
  prompt: z.string(),
  /** Why the task is in its current state, e.g. which budget deferred it. Shown in the UI. */
  note: z.string().nullish(),
  /** Set when this task duplicated in-flight work and was linked to it instead of running. */
  duplicateOf: z.string().nullish(),
  /** Org role that runs the task (see docs/ORG.md). Null on tasks from before roles existed: the vertical lead. */
  role: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

/** One normalised message from an agent run, independent of the runner that produced it. */
export const AgentMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), name: z.string().optional(), output: z.unknown(), isError: z.boolean().optional() }),
  z.object({ type: z.literal("system"), text: z.string() }),
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

export const RunStatus = z.enum(["running", "succeeded", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const AgentRun = z.object({
  id: z.string(),
  taskId: z.string(),
  runner: z.string(),
  status: RunStatus,
  result: z.string().nullable(),
  error: z.string().nullable(),
  costUsd: z.number().nullable(),
  sessionId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AgentRun = z.infer<typeof AgentRun>;

/**
 * Autonomy level for an outward-facing action type:
 * - draft: always ask before executing
 * - auto-with-digest: execute, report in the daily digest
 * - auto: execute silently
 */
export const Policy = z.enum(["draft", "auto-with-digest", "auto"]);
export type Policy = z.infer<typeof Policy>;

export const ProposalStatus = z.enum(["pending", "approved", "rejected", "executed", "failed"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const NewProposal = z.object({
  taskId: z.string().nullish(),
  vertical: z.string(),
  /** Dotted action type, e.g. "email.send", "odoo.message.post", "brain.write". */
  actionType: z.string().min(1),
  summary: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Groups related proposals (e.g. one message per open order) so they are approved or rejected together. */
  batchId: z.string().min(1).max(200).nullish(),
});
export type NewProposal = z.input<typeof NewProposal>;

export const Proposal = NewProposal.extend({
  id: z.string(),
  taskId: z.string().nullable(),
  batchId: z.string().nullable(),
  policy: Policy,
  status: ProposalStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  result: z.unknown().nullable(),
});
export type Proposal = z.infer<typeof Proposal>;

/** Capabilities a worker node can advertise; jobs list the ones they require. */
export const Capability = z.enum(["gpu", "ffmpeg", "davinci", "claude-local", "browser"]);
export type Capability = z.infer<typeof Capability>;

/** `cancelled`: stopped from the Devices page while still queued; it never ran. */
export const JobStatus = z.enum(["queued", "assigned", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: z.string(),
  kind: z.string(),
  requires: z.array(Capability),
  payload: z.record(z.string(), z.unknown()),
  status: JobStatus,
  nodeId: z.string().nullable(),
  /** Set for a job only one computer may run (e.g. `setup.install` for that computer). */
  targetNodeId: z.string().nullish(),
  progress: z.number().min(0).max(1).nullable(),
  result: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof Job>;

export const WorkerNode = z.object({
  id: z.string(),
  name: z.string(),
  capabilities: z.array(Capability),
  /** What's installed and whether it can install more (see ./setup.ts); null for older workers. */
  setup: NodeSetup.nullish(),
  online: z.boolean(),
  lastSeen: z.string(),
});
export type WorkerNode = z.infer<typeof WorkerNode>;
