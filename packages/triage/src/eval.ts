import { type Event, EventSource, Route, type TriageResult } from "@cc/core";
import { z } from "zod";
import type { TriageUsage } from "./shared";
import type { TriageContext, Triager } from "./triager";

/** One labelled example: an event as ingress would produce it, and the right answer. */
export const EvalFixture = z.object({
  event: z.object({
    source: EventSource,
    kind: z.string().min(1),
    title: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).default({}),
    vertical: z.string().nullish(),
  }),
  expected: z.object({ vertical: z.string(), intent: z.string(), route: Route.optional() }),
});
export type EvalFixture = z.infer<typeof EvalFixture>;

/** Parses JSONL (blank lines and `//` comments skipped). Errors name the line. */
export function parseFixtures(jsonl: string): EvalFixture[] {
  const out: EvalFixture[] = [];
  jsonl.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;
    try {
      out.push(EvalFixture.parse(JSON.parse(trimmed)));
    } catch (error) {
      throw new Error(`Fixture line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return out;
}

export interface EvalCase {
  index: number;
  title: string;
  expected: EvalFixture["expected"];
  result: TriageResult | null;
  latencyMs: number;
  /** Set when the triager threw (a fail-soft triager returns null instead). */
  error?: string;
}

export interface FieldScore {
  correct: number;
  total: number;
  accuracy: number;
}

export interface EvalReport {
  triager: string;
  cases: EvalCase[];
  /** Events the triager returned null for (counted as wrong). */
  unanswered: number;
  vertical: FieldScore;
  /** Intent counts as right only when the vertical is right too. */
  intent: FieldScore;
  /** Only over fixtures that give an expected route. */
  route: FieldScore;
  /** "expected → got" for every wrong vertical/intent, most frequent first. */
  confusion: { expected: string; got: string; count: number }[];
  latencyMs: { mean: number; p50: number; p95: number; max: number };
  usage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  /** Share of events the triager answered at or above `minConfidence`, and their intent accuracy. */
  confident: { minConfidence: number; share: number; intentAccuracy: number };
}

export interface EvalOptions {
  context: TriageContext;
  /** Events triaged at once (default 4). */
  concurrency?: number;
  /** Confidence the chain would accept; used for the "confident" slice (default 0.7). */
  minConfidence?: number;
  /** Usage the triager reported (pass `meter.usages` from `usageMeter()`). */
  usages?: TriageUsage[];
}

/** Collects `onUsage` reports from a triager for `runEval`. */
export function usageMeter() {
  const usages: TriageUsage[] = [];
  return { usages, onUsage: (u: TriageUsage) => void usages.push(u) };
}

export function fixtureEvent(f: EvalFixture, index: number): Event {
  return {
    id: `eval-${index + 1}`,
    source: f.event.source,
    vertical: f.event.vertical ?? null,
    kind: f.event.kind,
    title: f.event.title,
    payload: f.event.payload,
    dedupeKey: null,
    receivedAt: new Date().toISOString(),
  };
}

/** Runs every fixture through the triager and scores the results. */
export async function runEval(triager: Triager, fixtures: EvalFixture[], options: EvalOptions): Promise<EvalReport> {
  const cases: EvalCase[] = new Array(fixtures.length);
  let next = 0;
  const worker = async () => {
    while (next < fixtures.length) {
      const index = next++;
      const fixture = fixtures[index]!;
      const started = performance.now();
      let result: TriageResult | null = null;
      let error: string | undefined;
      try {
        result = await triager.triage(fixtureEvent(fixture, index), options.context);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      cases[index] = { index, title: fixture.event.title, expected: fixture.expected, result, latencyMs: performance.now() - started, error };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  return score(triager.name, cases, options);
}

function score(name: string, cases: EvalCase[], options: EvalOptions): EvalReport {
  const field = (pairs: boolean[]): FieldScore => {
    const correct = pairs.filter(Boolean).length;
    return { correct, total: pairs.length, accuracy: pairs.length ? correct / pairs.length : 0 };
  };
  const verticalOk = (c: EvalCase) => c.result?.vertical === c.expected.vertical;
  const intentOk = (c: EvalCase) => verticalOk(c) && c.result?.intent === c.expected.intent;

  const confusion = new Map<string, { expected: string; got: string; count: number }>();
  for (const c of cases) {
    if (intentOk(c)) continue;
    const expected = `${c.expected.vertical}/${c.expected.intent}`;
    const got = c.result ? `${c.result.vertical}/${c.result.intent}` : "(none)";
    const key = `${expected}→${got}`;
    const entry = confusion.get(key) ?? { expected, got, count: 0 };
    entry.count++;
    confusion.set(key, entry);
  }

  const latencies = cases.map((c) => c.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0;
  const usages = options.usages ?? [];
  const minConfidence = options.minConfidence ?? 0.7;
  const confidentCases = cases.filter((c) => c.result && c.result.confidence >= minConfidence);

  return {
    triager: name,
    cases,
    unanswered: cases.filter((c) => !c.result).length,
    vertical: field(cases.map(verticalOk)),
    intent: field(cases.map(intentOk)),
    route: field(cases.filter((c) => c.expected.route).map((c) => c.result?.route === c.expected.route)),
    confusion: [...confusion.values()].sort((a, b) => b.count - a.count || a.expected.localeCompare(b.expected)),
    latencyMs: {
      mean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p50: pct(0.5),
      p95: pct(0.95),
      max: latencies.at(-1) ?? 0,
    },
    usage: {
      calls: usages.length,
      inputTokens: usages.reduce((s, u) => s + u.inputTokens, 0),
      outputTokens: usages.reduce((s, u) => s + u.outputTokens, 0),
      costUsd: usages.reduce((s, u) => s + u.costUsd, 0),
    },
    confident: {
      minConfidence,
      share: cases.length ? confidentCases.length / cases.length : 0,
      intentAccuracy: field(confidentCases.map(intentOk)).accuracy,
    },
  };
}

/** Plain-text summary for the terminal. `target` is the intent accuracy needed before `auto` policies. */
export function formatReport(r: EvalReport, target = 0.9): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const fs = (s: FieldScore) => (s.total ? `${pct(s.accuracy)} (${s.correct}/${s.total})` : "n/a");
  const n = r.cases.length;
  const lines = [
    `Triager: ${r.triager}   events: ${n}   unanswered: ${r.unanswered}`,
    "",
    `Vertical accuracy  ${fs(r.vertical)}`,
    `Intent accuracy    ${fs(r.intent)}   ${r.intent.accuracy >= target ? "meets" : "BELOW"} the ${pct(target)} target`,
    `Route accuracy     ${fs(r.route)}`,
    `Confident (≥${r.confident.minConfidence})   ${pct(r.confident.share)} of events, intent accuracy ${pct(r.confident.intentAccuracy)}`,
    "",
    `Latency  mean ${ms(r.latencyMs.mean)}  p50 ${ms(r.latencyMs.p50)}  p95 ${ms(r.latencyMs.p95)}  max ${ms(r.latencyMs.max)}`,
  ];
  if (r.usage.calls) {
    const per1k = (r.usage.costUsd / Math.max(1, r.usage.calls)) * 1000;
    lines.push(
      `Usage    ${r.usage.calls} calls, ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens`,
      `Cost     $${r.usage.costUsd.toFixed(6)} total, ~$${per1k.toFixed(4)} per 1,000 events (estimate)`,
    );
  } else {
    lines.push("Cost     no usage reported (rules only, or the triager has no usage hook)");
  }
  if (r.confusion.length) {
    lines.push("", "Mistakes (expected → got):");
    for (const c of r.confusion) lines.push(`  ${String(c.count).padStart(3)}  ${c.expected} → ${c.got}`);
  }
  const wrong = r.cases.filter((c) => !(c.result?.vertical === c.expected.vertical && c.result?.intent === c.expected.intent));
  if (wrong.length) {
    lines.push("", "Wrong cases:");
    for (const c of wrong) {
      const got = c.result ? `${c.result.vertical}/${c.result.intent} (${c.result.route}, conf ${c.result.confidence.toFixed(2)})` : c.error ? `error: ${c.error}` : "null";
      lines.push(`  #${c.index + 1} ${c.title}`, `      expected ${c.expected.vertical}/${c.expected.intent}, got ${got}`);
    }
  }
  return lines.join("\n");
}

function ms(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}
