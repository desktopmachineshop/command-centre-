import { randomUUID } from "node:crypto";
import type { AgentRunResult } from "@cc/agent-runtime";
import type { Task, TaskStatus, VoiceResponse } from "@cc/core";
import { parseVoiceResponse, voiceResponseInstructions } from "@cc/voice";
import { voicePrompt } from "../agent-context";
import type { ChatFile, ChatFilesContext } from "../chat-files";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import type { TaskQueue } from "../queue";

/** A reply can't be added to a task in this state (e.g. it is still running). */
export class ReplyStateError extends Error {}

/** One reply about to drive a run (see `Pipeline.runTask`). */
export interface ReplyTurn {
  replyId: string;
  prompt: string;
  resumeSessionId?: string;
  /** With `resumeSessionId`: the prompt with the context spelled out, for a runner that can't resume it. */
  promptWithoutResume?: string;
  voice: boolean;
  /** Files Dave attached to the reply (images go to the runner with the prompt). */
  files?: ChatFile[];
}

export interface TaskReply {
  id: string;
  taskId: string;
  text: string;
  voice: boolean;
  runId: string | null;
  createdAt: string;
  consumedAt: string | null;
}

/** States a conversation can be continued from; queued/running tasks already have work in flight. */
const REPLYABLE: TaskStatus[] = ["done", "awaiting_approval", "failed"];

/**
 * Voice conversations on top of tasks:
 * - Dave's reply to a task (`reply`) is stored and re-queues the same task;
 * - the next run takes it (`beforeRun`) and resumes the previous run's agent session;
 * - every voice-mode run's answer is parsed into a `{text, type: converse | final}`
 *   response, stored on the run and broadcast as `run.response` (`afterRun`).
 */
export class VoiceConversations {
  constructor(
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly queue: TaskQueue,
  ) {}

  /** Continues `taskId` with Dave's `text`. The task is queued again; a new run on it answers. */
  /**
   * A report from a role that finished work this task handed off to it. Stored like a reply
   * (`author` names the role) and continues the task, so its agent can tell Dave the outcome.
   * While the task is still queued or running, the report waits and `takePending` re-queues the
   * task once its run is over. Voice tasks get a spoken answer.
   */
  /**
   * A role's note on a task: its report on work this task handed off, or (`followup`) a later
   * note from the role that handed this task off. It waits while the task runs, and queues it otherwise.
   */
  async report(taskId: string, author: string, text: string, kind: "report" | "followup" = "report"): Promise<Task | null> {
    const queued = await this.store.transaction(async (tx) => {
      const { rows } = await tx.pool.query("select status from tasks where id = $1 for update", [taskId]);
      if (!rows[0]) return null;
      const session = await tx.pool.query(
        "select session_id from agent_runs where task_id = $1 and session_id is not null order by started_at desc limit 1",
        [taskId],
      );
      const task = await tx.getTask(taskId);
      const voice = task ? await this.isVoiceTask(task) : false;
      await tx.pool.query(
        "insert into task_replies (id, task_id, text, voice, resume_session_id, author, kind) values ($1, $2, $3, $4, $5, $6, $7)",
        [randomUUID(), taskId, text, voice, session.rows[0]?.session_id ?? null, author, kind === "followup" ? "followup" : null],
      );
      return REPLYABLE.includes(rows[0].status) ? tx.setTaskStatus(taskId, "queued") : null;
    });
    if (!queued) return null;
    this.hub.broadcast({ type: "task.updated", task: queued });
    await this.queue.enqueue(queued.id);
    return queued;
  }

  /** The follow-up notes sent to a task by the role that handed it off, oldest first. */
  async followUps(taskId: string): Promise<string[]> {
    const { rows } = await this.store.pool.query("select text from task_replies where task_id = $1 and kind = 'followup' order by created_at", [taskId]);
    return rows.map((r) => r.text as string);
  }

  /** Drops the replies and reports no run has taken yet (the task was stopped), so nothing re-runs it. */
  async discardPending(taskId: string): Promise<void> {
    await this.store.pool.query("update task_replies set consumed_at = now() where task_id = $1 and consumed_at is null", [taskId]);
  }

  /** The files Dave attached to his replies on a task, oldest first (a handoff passes them on). */
  async replyFiles(taskId: string): Promise<ChatFile[]> {
    const { rows } = await this.store.pool.query("select files from task_replies where task_id = $1 and files is not null order by created_at", [taskId]);
    return rows.flatMap((r) => ((r.files as ChatFilesContext | null)?.files ?? []));
  }

  /** True when the task has replies or reports no run has taken yet. */
  async hasPending(taskId: string): Promise<boolean> {
    const { rows } = await this.store.pool.query("select 1 from task_replies where task_id = $1 and consumed_at is null limit 1", [taskId]);
    return rows.length > 0;
  }

  async reply(taskId: string, text: string, voice: boolean, files?: ChatFilesContext): Promise<Task | null> {
    const queued = await this.store.transaction(async (tx) => {
      const { rows } = await tx.pool.query("select status from tasks where id = $1 for update", [taskId]);
      if (!rows[0]) return null;
      if (!REPLYABLE.includes(rows[0].status)) {
        throw new ReplyStateError(`task is ${String(rows[0].status).replace("_", " ")}; reply once it has answered`);
      }
      const session = await tx.pool.query(
        "select session_id from agent_runs where task_id = $1 and session_id is not null order by started_at desc limit 1",
        [taskId],
      );
      await tx.pool.query(
        "insert into task_replies (id, task_id, text, voice, resume_session_id, files) values ($1, $2, $3, $4, $5, $6)",
        [randomUUID(), taskId, text, voice, session.rows[0]?.session_id ?? null, files?.files.length ? files : null],
      );
      return tx.setTaskStatus(taskId, "queued");
    });
    if (!queued) return null;
    this.hub.broadcast({ type: "task.updated", task: queued });
    await this.queue.enqueue(queued.id);
    return queued;
  }

  /**
   * The oldest unanswered reply on the task, bound to `runId`, as the run's
   * prompt. With the earlier run's session the agent resumes it; without one
   * (a runner that has no sessions) the prompt carries the context instead.
   */
  async beforeRun(task: Task, runId: string): Promise<ReplyTurn | null> {
    const { rows } = await this.store.pool.query(
      `update task_replies set run_id = $2
       where id = (select id from task_replies where task_id = $1 and consumed_at is null order by created_at limit 1)
       returning *`,
      [task.id, runId],
    );
    const reply = rows[0];
    if (!reply) return null;
    // Dave's own reply, or a report from a role this task handed work to.
    const fromDave = !reply.author || reply.author === "dave";
    const attached = reply.files as ChatFilesContext | null;
    const followUp = !fromDave && reply.kind === "followup";
    const said = fromDave
      ? `Dave replies: ${reply.text}${attached?.prompt ? `\n\n${attached.prompt}` : ""}`
      : followUp
        ? `Follow-up from ${reply.author}, who handed you this task:\n\n${reply.text}\n\nTake it into account and carry on with the task; your final summary goes back to them as before.`
        : `Report back from ${reply.author}, who took the work you handed off:\n\n${reply.text}\n\nUse it to finish your task: give the outcome in a sentence or two (what was done, and anything waiting for Dave's approval or decision). Don't redo their work.`;
    const marker = fromDave
      ? `Dave replied: ${reply.text}${attached?.files.length ? ` [attached: ${attached.files.map((f) => f.name).join(", ")}]` : ""}`
      : followUp
        ? `${reply.author} sent a follow-up: ${reply.text}`
        : `${reply.author} reported back: ${reply.text}`;
    this.store.appendRunMessage(runId, { type: "system", text: marker }).catch(() => {});
    this.hub.broadcast({ type: "run.message", runId, taskId: task.id, message: { type: "system", text: marker } });

    const answer = (text: string) => (reply.voice ? voicePrompt(text) : text);
    const last = await this.store.pool.query(
      "select result from agent_runs where task_id = $1 and id <> $2 and result is not null order by started_at desc limit 1",
      [task.id, runId],
    );
    const original = task.prompt.replace(`\n\n${voiceResponseInstructions}`, "").slice(0, 4000);
    const previous = String(last.rows[0]?.result ?? "").slice(0, 4000);
    const context = [
      "This continues an earlier conversation on this task.",
      `Original request: ${original}`,
      previous ? `Your last answer: ${previous}` : null,
      said,
    ]
      .filter(Boolean)
      .join("\n\n");
    const files = fromDave && attached?.files.length ? { files: attached.files } : {};
    if (reply.resume_session_id) {
      return {
        replyId: reply.id,
        prompt: answer(said),
        resumeSessionId: reply.resume_session_id,
        promptWithoutResume: answer(context),
        voice: reply.voice,
        ...files,
      };
    }
    return { replyId: reply.id, prompt: answer(context), voice: reply.voice, ...files };
  }

  /** Marks the turn's reply answered and, for voice-mode runs, stores and broadcasts the spoken response. */
  async afterRun(task: Task, runId: string, result: AgentRunResult, turn: ReplyTurn | null): Promise<VoiceResponse | null> {
    if (turn) await this.store.pool.query("update task_replies set consumed_at = now() where id = $1", [turn.replyId]);
    const voice = turn ? turn.voice : await this.isVoiceTask(task);
    if (!voice || result.status !== "succeeded") return null;
    const response = parseVoiceResponse(result.result);
    if (!response) return null;
    await this.store.pool.query("update agent_runs set voice_response = $2 where id = $1", [runId, response]);
    this.hub.broadcast({ type: "run.response", runId, taskId: task.id, response });
    return response;
  }

  /** Stored responses of a task's runs, by run id. */
  async responses(taskId: string): Promise<Map<string, VoiceResponse>> {
    const { rows } = await this.store.pool.query(
      "select id, voice_response from agent_runs where task_id = $1 and voice_response is not null",
      [taskId],
    );
    return new Map(rows.map((r) => [r.id as string, r.voice_response as VoiceResponse]));
  }

  async replies(taskId: string): Promise<TaskReply[]> {
    const { rows } = await this.store.pool.query("select * from task_replies where task_id = $1 order by created_at", [taskId]);
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      text: r.text,
      voice: r.voice,
      runId: r.run_id,
      createdAt: new Date(r.created_at).toISOString(),
      consumedAt: r.consumed_at ? new Date(r.consumed_at).toISOString() : null,
    }));
  }

  private async isVoiceTask(task: Task): Promise<boolean> {
    const event = await this.store.getEvent(task.eventId);
    return event?.source === "chat" && event.payload.voice === true;
  }
}
