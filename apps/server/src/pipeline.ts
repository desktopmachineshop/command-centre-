import type { AgentRunner } from "@cc/agent-runtime";
import type { Brain } from "@cc/brain";
import { type Event, NewEvent, type Task, type TaskStatus, type TriageResult } from "@cc/core";
import type { Triager } from "@cc/triage";
import { DEFAULT_VERTICAL, type VerticalRegistry } from "@cc/verticals";
import type { ActionService } from "./actions";
import { allowedToolsFor, mcpServersFor, systemPrompt, taskPrompt } from "./agent-context";
import type { Store } from "./db/store";
import type { Hub } from "./hub";
import type { TaskQueue } from "./queue";
import type { RunTokens } from "./run-tokens";
import { prepareWorkspace } from "./workspace";

export interface PipelineDeps {
  store: Store;
  hub: Hub;
  triager: Triager;
  verticals: VerticalRegistry;
  runner: AgentRunner;
  queue: TaskQueue;
  brain: Brain;
  actions: ActionService;
  runTokens: RunTokens;
  dataDir: string;
  skillsDir: string;
  internalBaseUrl: string;
  maxTurns: number;
}

/** Fallback when no triager is confident: hand the event to the agent in the default vertical. */
const UNTRIAGED: Omit<TriageResult, "vertical"> = {
  intent: "other",
  urgency: 0.3,
  route: "agent",
  confidence: 0,
  triager: "fallback",
};

/**
 * Event → triage → task → (route) → agent run → proposals.
 * Every ingress adapter ends in `ingest`.
 */
export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async ingest(input: NewEvent): Promise<{ event: Event; task: Task } | null> {
    const { store, hub, triager, verticals } = this.deps;
    const parsed = NewEvent.parse(input);
    if (parsed.vertical && !verticals.get(parsed.vertical)) throw new Error(`Unknown vertical: ${parsed.vertical}`);

    const event = await store.insertEvent(parsed);
    if (!event) return null; // duplicate
    hub.broadcast({ type: "event.created", event });

    const context = { verticals: verticals.all(), defaultVertical: DEFAULT_VERTICAL };
    let triage = (await triager.triage(event, context)) ?? {
      ...UNTRIAGED,
      vertical: event.vertical ?? DEFAULT_VERTICAL,
    };
    if (!verticals.get(triage.vertical)) triage = { ...triage, vertical: DEFAULT_VERTICAL };

    const status: TaskStatus = triage.route === "agent" || triage.route === "cheap-agent" ? "queued" : "done";
    let task = await store.insertTask({
      eventId: event.id,
      triage,
      status: triage.route === "drop" ? "dropped" : status,
      prompt: taskPrompt(event),
    });
    hub.broadcast({ type: "task.updated", task });

    if (triage.route === "file") {
      await this.deps.brain.appendJournal(event.title, { vertical: triage.vertical });
    } else if (task.status === "queued") {
      await this.deps.queue.enqueue(task.id);
    }
    return { event, task };
  }

  /** Executes one queued task with the agent runner. Called by the queue worker. */
  async runTask(taskId: string): Promise<void> {
    const { store, hub, runner, verticals, runTokens } = this.deps;
    const queued = await store.getTask(taskId);
    if (!queued || (queued.status !== "queued" && queued.status !== "running")) return;

    const vertical = verticals.require(queued.vertical);
    const task = await store.setTaskStatus(taskId, "running");
    hub.broadcast({ type: "task.updated", task });

    const run = await store.insertRun(taskId, runner.name);
    const token = runTokens.issue({ taskId, runId: run.id, vertical: vertical.id });
    try {
      const cwd = await prepareWorkspace(this.deps.dataDir, this.deps.skillsDir, vertical);
      const mcpServers = mcpServersFor(vertical, this.deps.internalBaseUrl, token);

      // Persist messages in order without blocking the stream.
      let chain = Promise.resolve();
      const result = await runner.run(
        {
          prompt: task.prompt,
          systemPrompt: systemPrompt(vertical, this.deps.actions.executors),
          cwd,
          mcpServers,
          allowedTools: allowedToolsFor(mcpServers),
          maxTurns: this.deps.maxTurns,
        },
        (message) => {
          hub.broadcast({ type: "run.message", runId: run.id, taskId, message });
          chain = chain.then(() => store.appendRunMessage(run.id, message)).catch(() => {});
        },
      );
      await chain;
      await store.finishRun(run.id, result);

      const pending = await store.listProposals({ taskId, status: "pending" });
      const next: TaskStatus = result.status === "failed" ? "failed" : pending.length > 0 ? "awaiting_approval" : "done";
      hub.broadcast({ type: "task.updated", task: await store.setTaskStatus(taskId, next) });
    } catch (err) {
      await store.finishRun(run.id, {
        status: "failed",
        result: null,
        error: (err as Error).message,
        costUsd: null,
        sessionId: null,
      });
      hub.broadcast({ type: "task.updated", task: await store.setTaskStatus(taskId, "failed") });
    } finally {
      runTokens.revoke(token);
    }
  }
}
