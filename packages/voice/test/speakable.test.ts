import { describe, expect, it } from "vitest";
import { parseVoiceResponse, speakable, spokenUsd, voiceResponseLine } from "../src/index";

describe("speakable", () => {
  it("strips markdown, tables and URLs", () => {
    const md = [
      "## Order 1042",
      "",
      "**Shipped** yesterday via [DPD](https://dpd.co.uk/track/123).",
      "",
      "| Item | Qty |",
      "|---|---|",
      "| ER11 collet | 2 |",
      "",
      "- Tracking: https://example.com/x",
      "```json",
      '{"a":1}',
      "```",
    ].join("\n");
    expect(speakable(md)).toBe("Order 1042. Shipped yesterday via DPD. Item, Qty. ER11 collet, 2. Tracking: a link.");
  });

  it("speaks money naturally", () => {
    expect(speakable("It cost $3.20 and £1,250 (20% off)")).toBe("It cost 3 dollars 20 and 1,250 pounds (20 percent off).");
    expect(spokenUsd(0.42)).toBe("42 cents");
    expect(spokenUsd(1)).toBe("1 dollar");
    expect(spokenUsd(0)).toBe("nothing");
    expect(spokenUsd(0.001)).toBe("less than a cent");
  });

  it("cuts long text at a sentence", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const out = speakable(long, { maxChars: 100 });
    expect(out.length).toBeLessThan(160);
    expect(out).toMatch(/is here\. There's more on screen when you're parked\.$/);
  });
});

describe("parseVoiceResponse", () => {
  it("reads the trailing protocol line", () => {
    const result = `Checked Odoo.\n${voiceResponseLine("Which supplier, Arc or Cutwel?", "converse")}`;
    expect(parseVoiceResponse(result)).toEqual({ text: "Which supplier, Arc or Cutwel?", type: "converse", structured: true });
  });

  it("tolerates code fences and finds the last valid line", () => {
    const result = ['{"voice":{"type":"converse","text":"old"}}', "```json", '{"voice": {"type": "final", "text": "Order 1042 shipped on Monday."}}', "```"].join("\n");
    expect(parseVoiceResponse(result)).toEqual({ text: "Order 1042 shipped on Monday.", type: "final", structured: true });
  });

  it("falls back to a final response from the plain answer", () => {
    expect(parseVoiceResponse("**Done.** Reminder set for 3pm.")).toEqual({ text: "Done. Reminder set for 3pm.", type: "final", structured: false });
    expect(parseVoiceResponse('{"voice":{"type":"maybe","text":"x"}}')?.structured).toBe(false);
    expect(parseVoiceResponse("  ")).toBeNull();
    expect(parseVoiceResponse(null)).toBeNull();
  });
});
