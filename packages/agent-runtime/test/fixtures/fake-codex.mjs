#!/usr/bin/env node
// Stand-in for the `codex` CLI: reads the prompt on stdin and prints `codex exec --json` events,
// in the shapes codex-cli 0.167 prints them.
// FAKE_CODEX_MODE=limit fails like a ChatGPT plan usage limit; crash exits without a result;
// args prints the arguments and CODEX_HOME it was given as the answer.
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const mode = process.env.FAKE_CODEX_MODE;
  if (mode === "crash") {
    process.stderr.write("Error: something broke\n");
    process.exit(3);
  }
  out({ type: "thread.started", thread_id: "thread-1" });
  out({ type: "turn.started" });
  if (mode === "limit") {
    out({ type: "error", message: "You've hit your usage limit. Upgrade to Pro or try again later." });
    out({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again later." } });
    process.exit(1);
  }
  if (mode === "args") {
    const text = JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME ?? null, cwd: process.cwd() });
    out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
    out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    return;
  }
  out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
  const call = { id: "item_1", type: "mcp_tool_call", server: "brain", tool: "search", arguments: { query: prompt }, result: null, error: null, status: "in_progress" };
  out({ type: "item.started", item: call });
  out({ type: "item.completed", item: { ...call, result: { content: [{ type: "text", text: "no notes" }] }, status: "completed" } });
  out({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "bash -lc false", aggregated_output: "", exit_code: 1, status: "failed" } });
  out({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: `answer to ${prompt}` } });
  out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
});
