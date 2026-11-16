import type { AgentMessage } from "@cc/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { stepsSummary, toolLabel } from "../src/format";
import { Transcript, transcriptParts } from "../src/pages/Transcript";

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
    use("mcp__odoo__search_products"),
    result("mcp__odoo__search_products"),
    text("We have 12 in stock."),
    use("mcp__actions__update_handover"),
    result("mcp__actions__update_handover"),
    text('{"voice":{"type":"final","text":"Twelve."}}'),
  ];

  it("folds each run of tool calls into one part, and keeps what was said", () => {
    const parts = transcriptParts(messages);
    expect(parts.map((p) => (p.kind === "steps" ? `steps:${p.steps.length}` : p.message.type))).toEqual(["steps:3", "text", "steps:2"]);
    expect(transcriptParts([{ type: "system", text: "session abc started" }])).toEqual([]);
    // Other system lines (a switch of runner, a note) are still shown.
    expect(transcriptParts([{ type: "system", text: "Claude hit its limit; carrying on with ChatGPT" }])).toHaveLength(1);
  });

  it("shows the answer in full with the steps closed above it", () => {
    const out = renderToStaticMarkup(createElement(Transcript, { messages }));
    expect(out).toContain("<summary>1 step: Odoo</summary>");
    expect(out).toContain("We have 12 in stock.");
    expect(out).not.toContain("Twelve.");
    expect(out).toContain("→ Odoo: search products");
    expect(out.indexOf("1 step: Odoo")).toBeLessThan(out.indexOf("We have 12"));
  });

  it("says what a running agent is doing", () => {
    const running = renderToStaticMarkup(createElement(Transcript, { messages: messages.slice(0, 2), working: true }));
    expect(running).toContain("Working: Odoo: search products…");
    const between = renderToStaticMarkup(createElement(Transcript, { messages: messages.slice(0, 4), working: true }));
    expect(between).toContain("Still working…");
    expect(renderToStaticMarkup(createElement(Transcript, { messages: [], working: true }))).toBe('<div class="transcript"></div>');
  });
});
