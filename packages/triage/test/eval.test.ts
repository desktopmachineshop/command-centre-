import { readFile } from "node:fs/promises";
import type { TriageResult } from "@cc/core";
import { DEFAULT_VERTICAL, verticals } from "@cc/verticals";
import { describe, expect, it } from "vitest";
import { formatReport, parseFixtures, runEval, type Triager, usageMeter } from "../src";

const context = { verticals: [...verticals], defaultVertical: DEFAULT_VERTICAL };

const line = (title: string, vertical: string, intent: string, route?: string) =>
  JSON.stringify({
    event: { source: "email", kind: "message", title, payload: { text: title } },
    expected: { vertical, intent, ...(route ? { route } : {}) },
  });

describe("parseFixtures", () => {
  it("skips blanks and comments and names the bad line", () => {
    expect(parseFixtures(`// comment\n${line("a", "dms", "spam")}\n\n${line("b", "dms", "supplier")}`)).toHaveLength(2);
    expect(() => parseFixtures(`${line("a", "dms", "spam")}\n{"event":{}}`)).toThrow(/line 2/);
  });

  it("parses the bundled DMS sample, whose labels exist in the real manifests", async () => {
    const fixtures = parseFixtures(await readFile(new URL("../fixtures/dms-sample.jsonl", import.meta.url), "utf8"));
    expect(fixtures.length).toBeGreaterThanOrEqual(25);
    for (const f of fixtures) {
      const v = verticals.find((x) => x.id === f.expected.vertical);
      expect(v, f.event.title).toBeDefined();
      expect([...v!.intents, "other"], f.event.title).toContain(f.expected.intent);
    }
  });
});

describe("runEval", () => {
  // Answers from a lookup by title; "slow" takes longer, "missing" returns null, "boom" throws.
  const answers: Record<string, Partial<TriageResult> | null> = {
    a: { vertical: "dms", intent: "spam", route: "drop", confidence: 0.95 },
    b: { vertical: "dms", intent: "presales-question", route: "agent", confidence: 0.9 },
    c: { vertical: "dms", intent: "presales-question", route: "cheap-agent", confidence: 0.5 },
    d: { vertical: "personal", intent: "admin", route: "agent", confidence: 0.8 },
    missing: null,
  };
  const meter = usageMeter();
  const fake: Triager = {
    name: "fake",
    async triage(event) {
      if (event.title === "boom") throw new Error("kaput");
      await new Promise((r) => setTimeout(r, event.title === "b" ? 30 : 1));
      const a = answers[event.title];
      if (!a) return null;
      meter.onUsage({ triager: "fake", model: "m", inputTokens: 100, outputTokens: 10, costUsd: 0.001 });
      return { urgency: 0.5, triager: "fake", ...a } as TriageResult;
    },
  };

  it("scores fields, confusion, latency and cost", async () => {
    const fixtures = parseFixtures(
      [
        line("a", "dms", "spam", "drop"), // all right
        line("b", "dms", "supplier", "agent"), // wrong intent, right route
        line("c", "dms", "presales-question", "agent"), // right intent, wrong route
        line("d", "dms", "invoice-admin"), // wrong vertical
        line("missing", "dms", "order-status"),
        line("boom", "personal", "plan"),
      ].join("\n"),
    );
    const report = await runEval(fake, fixtures, { context, concurrency: 2, usages: meter.usages });

    expect(report.cases.map((c) => c.title)).toEqual(["a", "b", "c", "d", "missing", "boom"]);
    expect(report.unanswered).toBe(2);
    expect(report.vertical).toEqual({ correct: 3, total: 6, accuracy: 0.5 });
    expect(report.intent).toEqual({ correct: 2, total: 6, accuracy: 2 / 6 });
    expect(report.route).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
    expect(report.confusion).toEqual(
      expect.arrayContaining([
        { expected: "dms/supplier", got: "dms/presales-question", count: 1 },
        { expected: "dms/invoice-admin", got: "personal/admin", count: 1 },
        { expected: "dms/order-status", got: "(none)", count: 1 },
      ]),
    );
    expect(report.cases[5]!.error).toBe("kaput");
    expect(report.latencyMs.max).toBeGreaterThanOrEqual(25);
    expect(report.latencyMs.p50).toBeLessThanOrEqual(report.latencyMs.p95);
    expect(report.usage).toEqual({ calls: 4, inputTokens: 400, outputTokens: 40, costUsd: 0.004 });
    // a, b and d clear 0.7; of those only a has the right intent.
    expect(report.confident.share).toBeCloseTo(0.5);
    expect(report.confident.intentAccuracy).toBeCloseTo(1 / 3);

    const text = formatReport(report);
    expect(text).toContain("Intent accuracy    33.3% (2/6)   BELOW the 90.0% target");
    expect(text).toContain("dms/supplier → dms/presales-question");
    expect(text).toContain("error: kaput");
    expect(text).toContain("per 1,000 events");
  });
});
