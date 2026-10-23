#!/usr/bin/env node
// Stand-in for the `claude` CLI: reads the prompt on stdin and prints stream-json.
// FAKE_CLAUDE_MODE=limit makes it fail like a subscription usage limit.
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "system", subtype: "init", session_id: "sess-1", args: process.argv.slice(2) });
  if (process.env.FAKE_CLAUDE_MODE === "limit") {
    out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached", session_id: "sess-1" });
    return;
  }
  if (process.env.FAKE_CLAUDE_MODE === "crash") process.exit(3);
  out({ type: "assistant", session_id: "sess-1", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__brain__search", input: { query: prompt } }] } });
  out({ type: "user", session_id: "sess-1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "no notes" }] } });
  out({ type: "assistant", session_id: "sess-1", message: { content: [{ type: "text", text: `answer to ${prompt}` }] } });
  out({ type: "result", subtype: "success", is_error: false, result: `answer to ${prompt}`, total_cost_usd: 0.01, session_id: "sess-1" });
});
