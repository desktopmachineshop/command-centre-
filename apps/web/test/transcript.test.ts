import type { AgentMessage } from "@cc/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { stepsSummary, toolLabel } from "../src/format";
import { runOpener, splitTranscript, Transcript } from "../src/pages/Transcript";

const use = (name: string): AgentMessage => ({ type: "tool_use", name, input: {} });
const result = (name: string, isError = false): AgentMessage => ({ type: "tool_result", name, output: "ok", isError });
const text = (t: string): AgentMessage => ({ type: "text", text: t });

describe("tool names for reading", () => {
  it("names the integration and the tool in words", () => {
    expect(toolLabel("mcp__odoo__search_products")).toBe("Odoo: search products");
    expect(toolLabel("mcp__pa__add_reminder")).toBe("Calendar and lists: add reminder");
    expect(toolLabel("mcp__actions__propose_action")).toBe("Proposing an action");
    expect(toolLabel("mcp__actions__update_handover")).toBe("Saving its notes on this task");
    expect(toolLabel("ToolSearch")).toBe("Finding the right tools");
    expect(toolLabel("mcp__newthing__do_it")).toBe("Newthing: do it");
    expect(toolLabel("Bash")).toBe("Bash");
  });

  it("sums a run of calls up in one line", () => {
    const steps = [use("ToolSearch"), result("ToolSearch"), use("mcp__odoo__search_orders"), result("mcp__odoo__search_orders"), use("mcp__brain__search"), result("mcp__brain__search"), use("mcp__odoo__get_order"), result("mcp__odoo__get_order")];
    expect(stepsSummary(steps)).toBe("4 steps: Odoo, Brain");
    expect(stepsSummary([use("mcp__mail__send"), result("mcp__mail__send", true)])).toBe("1 step: Mail · 1 problem");
    expect(stepsSummary(steps, true)).toBe("Working: Odoo: get order…");
    expect(stepsSummary([{ type: "system" }], true)).toBe("Working on it…");
  });
});

describe("Transcript", () => {
  const messages: AgentMessage[] = [
    { type: "system", text: "session abc started" },
    text("Let me look."),
    use("mcp__odoo__search_products"),
    result("mcp__odoo__search_products"),
    use("mcp__actions__update_handover"),
    result("mcp__actions__update_handover"),
    text("We have 12 in stock."),
    text('{"voice":{"type":"final","text":"Twelve."}}'),
  ];

  it("splits what it did from what it said", () => {
    const { trace, answer } = splitTranscript(messages);
    expect(trace.map((m) => m.type)).toEqual(["system", "text", "tool_use", "tool_result", "tool_use", "tool_result"]);
    expect(answer).toEqual([text("We have 12 in stock.")]);
    // No tools: everything said is the answer, and a lone session line is dropped.
    expect(splitTranscript([messages[0]!, text("Hello.")])).toEqual({ trace: [], answer: [text("Hello.")] });
  });

  it("answers with the last thing said when a finished run ended on a tool call", () => {
    const ended = [use("mcp__odoo__get_order"), result("mcp__odoo__get_order"), text("It shipped on Monday."), use("mcp__actions__update_handover"), result("mcp__actions__update_handover")];
    expect(splitTranscript(ended).answer).toEqual([text("It shipped on Monday.")]);
    expect(splitTranscript(ended).trace).toHaveLength(4);
    // Still working: that text is a note so far, not yet known to be the answer.
    expect(splitTranscript(ended, true).answer).toEqual([]);
  });

  it("shows one folded line for everything it did, then the answer", () => {
    const out = renderToStaticMarkup(createElement(Transcript, { messages }));
    expect(out.match(/<details class="steps/g)).toHaveLength(1);
    expect(out).toContain("<summary>2 steps: Odoo</summary>");
    expect(out).not.toContain('<details class="steps " open');
    expect(out).toContain("We have 12 in stock.");
    expect(out).not.toContain("Twelve.");
    // Unfolded, everything is there in order: the note it made, each call and result.
    expect(out).toContain("Let me look.");
    expect(out).toContain("→ Odoo: search products");
    expect(out.indexOf("2 steps: Odoo")).toBeLessThan(out.indexOf("We have 12"));
  });

  it("says what a running agent is doing, on that one line", () => {
    const running = renderToStaticMarkup(createElement(Transcript, { messages: messages.slice(0, 3), working: true }));
    expect(running.match(/<details class="steps/g)).toHaveLength(1);
    expect(running).toContain("Working: Odoo: search products…");
    const later = renderToStaticMarkup(createElement(Transcript, { messages: messages.slice(0, 5), working: true }));
    expect(later).toContain("Working: Saving its notes on this task…");
    expect(renderToStaticMarkup(createElement(Transcript, { messages: [], working: true }))).toBe('<div class="transcript is-working"></div>');
    expect(renderToStaticMarkup(createElement(Transcript, { messages: [messages[0]!], working: true }))).toContain("Working on it…");
  });

  it("leaves the line that opened the run to the thread, which shows it as a bubble", () => {
    const run: AgentMessage[] = [{ type: "system", text: "Dave replied: make it Friday [attached: note.pdf]" }, text("Done: Friday.")];
    expect(runOpener(run)).toEqual({ from: "dave", author: "Dave", kind: "reply", text: "make it Friday" });
    expect(renderToStaticMarkup(createElement(Transcript, { messages: run }))).not.toContain("Dave replied");
    expect(runOpener([{ type: "system", text: "the Software Lead (Command Centre) reported back: Merged PR 12." }])).toEqual({ from: "role", author: "the Software Lead (Command Centre)", kind: "report", text: "Merged PR 12." });
    expect(runOpener([{ type: "system", text: "the Chief of Staff sent a follow-up: also check 13" }])?.kind).toBe("followup");
    expect(runOpener(messages)).toBeNull();
  });
});
