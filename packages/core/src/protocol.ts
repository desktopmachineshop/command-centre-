import { z } from "zod";
import { AgentMessage, Capability, Event, Job, Proposal, Task, WorkerNode } from "./domain";
import { NodeSetup } from "./setup";

/** Voice mode: the spoken answer of a run. `converse` waits for Dave's reply, `final` is done. */
export const VoiceResponse = z.object({ text: z.string(), type: z.enum(["converse", "final"]), structured: z.boolean() });
export type VoiceResponse = z.infer<typeof VoiceResponse>;

/**
 * WebSocket protocol between the server and its clients (PWA / desktop UI)
 * and worker nodes (desktop daemon). Every frame is one JSON message.
 */

export const ClientHello = z.object({
  type: z.literal("hello"),
  role: z.enum(["client", "worker"]),
  token: z.string(),
  /** Workers only: stable node id, display name and capabilities. */
  node: z
    .object({ id: z.string(), name: z.string(), capabilities: z.array(Capability), setup: NodeSetup.optional() })
    .optional(),
});

export const WorkerHeartbeat = z.object({ type: z.literal("worker.heartbeat") });
/** Workers only: capabilities and setup changed while connected (e.g. after a setup.install job). */
export const WorkerCapabilities = z.object({ type: z.literal("worker.capabilities"), capabilities: z.array(Capability), setup: NodeSetup.optional() });
export const JobProgress = z.object({
  type: z.literal("job.progress"),
  jobId: z.string(),
  progress: z.number().min(0).max(1),
  message: z.string().optional(),
});
export const JobComplete = z.object({ type: z.literal("job.complete"), jobId: z.string(), result: z.unknown() });
export const JobFail = z.object({ type: z.literal("job.fail"), jobId: z.string(), error: z.string() });

export const InboundMessage = z.discriminatedUnion("type", [
  ClientHello,
  WorkerHeartbeat,
  WorkerCapabilities,
  JobProgress,
  JobComplete,
  JobFail,
]);
export type InboundMessage = z.infer<typeof InboundMessage>;

export const OutboundMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), role: z.enum(["client", "worker"]) }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("event.created"), event: Event }),
  z.object({ type: z.literal("task.updated"), task: Task }),
  z.object({ type: z.literal("run.message"), runId: z.string(), taskId: z.string(), message: AgentMessage }),
  z.object({ type: z.literal("proposal.updated"), proposal: Proposal }),
  z.object({ type: z.literal("job.updated"), job: Job }),
  z.object({ type: z.literal("job.assign"), job: Job }),
  // Workers only: Dave pressed Update on the Devices page. The worker asks its desktop app to
  // install the newest signed build once its current job is done (WorkerService.requestUpdate).
  z.object({ type: z.literal("app.update") }),
  z.object({ type: z.literal("node.updated"), node: WorkerNode }),
  // Voice mode: a finished run's structured spoken answer (see @cc/voice parseVoiceResponse).
  z.object({ type: z.literal("run.response"), runId: z.string(), taskId: z.string(), response: VoiceResponse }),
  // notifications: the notification centre's unread count changed
  z.object({ type: z.literal("notifications.updated"), unread: z.number().int() }),
  // integrations: the Accounts page saved or removed credentials (refetch /api/integrations)
  z.object({ type: z.literal("integrations.updated") }),
  // The org (roles, policies) changed on the Org page.
  z.object({ type: z.literal("org.updated") }),
]);
export type OutboundMessage = z.infer<typeof OutboundMessage>;

export function parseInbound(raw: string): InboundMessage | null {
  try {
    const result = InboundMessage.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
