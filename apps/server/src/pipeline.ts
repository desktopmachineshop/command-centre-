import type { AgentRunner } from "@cc/agent-runtime";
import type { Brain } from "@cc/brain";
import { type Event, NewEvent, type Task, type TaskStatus, type TriageResult } from "@cc/core";
import type { Triager } from "@cc/triage";
import { DEFAULT_VERTICAL, type VerticalRegistry } from "@cc/verticals";
import type { ActionService } from "./actions";
import { allowedToolsFor, mcpServersFor, systemPrompt, taskPrompt } from "./agent-context";
import { type BudgetService, bypassesBudget } from "./budget";
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
  /** MCP servers mounted at /mcp/<name> that manifests may list. Default: brain. */
  mcpServers?: string[];
  budget: BudgetService;
  guards: RunGuards;
}

/** Limits on how much agent work runs at once. */
export interface RunGuards {
  /** Running tasks allowed per vertical; extra ones wait `busyRetrySeconds` and try again. */
  maxConcurrentPerVertical: number;
  busyRetrySeconds: number;
  /** A "running" task untouched this long is treated as crashed and stops holding its slot. */
  staleRunSeconds: number;
  /** Identical prompts in the same vertical within this window are linked, not re-run. 0 disables. */
  dedupeWindowMinutes: number;
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
    const prompt = taskPrompt(event);
    const duplicate = status === "queued" ? await this.inFlightDuplicate(triage.vertical, prompt, event) : null;
    let task = await store.insertTask({
      eventId: event.id,
      triage,
      status: triage.route === "drop" || duplicate ? "dropped" : status,
      prompt,
      duplicateOf: duplicate?.id ?? null,
      note: duplicate ? `Same request as a task that is already ${duplicate.status}; linked to it instead of running again.` : null,
    });
    hub.broadcast({ type: "task.updated", task });

    if (triage.route === "file") {
      await this.deps.brain.appendJournal(event.title, { vertical: triage.vertical });
    } else if (task.status === "queued") {
      await this.deps.queue.enqueue(task.id);
    }
    return { event, task };
  }

  /**
   * Work already queued, running or deferred in the same vertical with the
   * identical prompt. Chat skips deferred matches, since chat would run now.
   */
  private async inFlightDuplicate(vertical: string, prompt: string, event: Event): Promise<Task | null> {
    const minutes = this.deps.guards.dedupeWindowMinutes;
    if (minutes <= 0) return null;
    const statuses: TaskStatus[] = bypassesBudget(event) ? ["queued", "running"] : ["queued", "running", "deferred"];
    return this.deps.store.findInFlightDuplicate(vertical, prompt, statuses, minutes);
  }

  /**
   * Executes one queued task with the agent runner. Called by the queue worker.
   * It first takes a per-vertical run slot (if none is free it is re-queued shortly),
   * then checks the daily budgets (if over, it is deferred; see `bypassesBudget`).
   */
  async runTask(taskId: string): Promise<void> {
    const { store, hub, runner, verticals, runTokens, budget, guards } = this.deps;
    const queued = await store.getTask(taskId);
    if (!queued || (queued.status !== "queued" && queued.status !== "running")) return;

    const vertical = verticals.require(queued.vertical);
    const claim = await store.claimTaskRun(taskId, { max: guards.maxConcurrentPerVertical, staleSeconds: guards.staleRunSeconds });
    if (claim.state === "gone") return;
    if (claim.state === "busy") {
      await this.deps.queue.enqueue(taskId, { delaySeconds: guards.busyRetrySeconds });
      return;
    }
    if (!claim.budgetOverride && !bypassesBudget(await store.getEvent(queued.eventId))) {
      const breach = await budget.check(vertical);
      if (breach) {
        hub.broadcast({ type: "task.updated", task: await store.setTaskStatus(taskId, "deferred", budget.note(vertical, breach)) });
        await budget.alert(vertical, breach).catch((err) => console.error("[budget]", err));
        return;
      }
    }
    const task = claim.task;
    hub.broadcast({ type: "task.updated", task });

    const run = await store.insertRun(taskId, runner.name);
    const token = runTokens.issue({ taskId, runId: run.id, vertical: vertical.id });
    try {
      const cwd = await prepareWorkspace(this.deps.dataDir, this.deps.skillsDir, vertical);
      const mcpServers = mcpServersFor(vertical, this.deps.internalBaseUrl, token, this.deps.mcpServers);

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

  /** Re-runs a failed or deferred task now, ignoring the budget once. Null if it isn't retryable. */
  async retry(taskId: string): Promise<Task | null> {
    const task = await this.deps.store.requeueForRetry(taskId);
    if (!task) return null;
    this.deps.hub.broadcast({ type: "task.updated", task });
    await this.deps.queue.enqueue(task.id);
    return task;
  }

  /**
   * Re-queues every deferred task. Runs after the budget day rolls over (and on
   * boot, in case the server was down at midnight). Tasks still over budget are
   * deferred again, without a second notification.
   */
  async releaseDeferred(): Promise<Task[]> {
    const tasks = await this.deps.store.requeueDeferred();
    for (const task of tasks) {
      this.deps.hub.broadcast({ type: "task.updated", task });
      await this.deps.queue.enqueue(task.id);
    }
    return tasks;
  }
}
