import type { AgentMessage } from "@cc/core";
import type { AgentRunner, AgentRunRequest, AgentRunResult, OnAgentMessage } from "./runner";

export type Script = (request: AgentRunRequest) => { messages?: AgentMessage[]; result: AgentRunResult };

/**
 * Deterministic runner for tests and for running the server without any model
 * (AGENT_RUNNER=echo): replies with the prompt it was given.
 */
export class ScriptedRunner implements AgentRunner {
  readonly calls: AgentRunRequest[] = [];

  constructor(
    readonly name: string = "echo",
    private readonly script: Script = (req) => ({
      messages: [{ type: "text", text: `echo: ${req.prompt}` }],
      result: { status: "succeeded", result: `echo: ${req.prompt}`, error: null, costUsd: 0, sessionId: null },
    }),
  ) {}

  async run(request: AgentRunRequest, onMessage: OnAgentMessage = () => {}): Promise<AgentRunResult> {
    this.calls.push(request);
    const { messages = [], result } = this.script(request);
    for (const m of messages) onMessage(m);
    return result;
  }
}
