/**
 * Triage accuracy eval.
 *
 *   pnpm --filter @cc/triage eval fixtures/dms-sample.jsonl [--triager chain|rules|jev|haiku] [--json] [--fail-under 0.9]
 *
 * Model triagers read JEV_API_KEY / JEV_BASE_URL / JEV_MODEL and ANTHROPIC_TRIAGE_API_KEY from the
 * environment. Each event is a real (billed) API call.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_VERTICAL, verticals } from "@cc/verticals";
import { AnthropicTriager, ChainTriager, formatReport, JevTriager, parseFixtures, RulesTriager, runEval, type Triager, usageMeter } from "../src";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    triager: { type: "string", default: "chain" },
    json: { type: "boolean", default: false },
    "fail-under": { type: "string" },
    "min-confidence": { type: "string", default: process.env.TRIAGE_MIN_CONFIDENCE ?? "0.7" },
    concurrency: { type: "string", default: "4" },
  },
});

const file = positionals[0];
if (!file) {
  console.error("Usage: pnpm --filter @cc/triage eval <fixtures.jsonl> [--triager chain|rules|jev|haiku] [--json] [--fail-under 0.9]");
  process.exit(2);
}

const meter = usageMeter();
const minConfidence = Number(values["min-confidence"]);
const onError = (e: unknown) => console.error(`triage error: ${e instanceof Error ? e.message : String(e)}`);
const env = process.env;

const jev = env.JEV_API_KEY
  ? new JevTriager({ apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL, onUsage: meter.onUsage, onError })
  : undefined;
const haiku = env.ANTHROPIC_TRIAGE_API_KEY
  ? new AnthropicTriager({ apiKey: env.ANTHROPIC_TRIAGE_API_KEY, onUsage: meter.onUsage, onError })
  : undefined;

const pick: Record<string, () => Triager | undefined> = {
  rules: () => new RulesTriager(),
  jev: () => jev,
  haiku: () => haiku,
  chain: () => new ChainTriager([new RulesTriager(), ...(jev ? [jev] : []), ...(haiku ? [haiku] : [])], minConfidence),
};
const triager = pick[values.triager]?.();
if (!triager) {
  console.error(`Triager "${values.triager}" is unknown or not configured (set JEV_API_KEY / ANTHROPIC_TRIAGE_API_KEY).`);
  process.exit(2);
}

// pnpm --filter runs in the package directory; resolve the path from where the command was typed.
const path = resolve(env.INIT_CWD ?? process.cwd(), file);
const fixtures = parseFixtures(await readFile(path, "utf8"));
const report = await runEval(triager, fixtures, {
  context: { verticals: [...verticals], defaultVertical: DEFAULT_VERTICAL },
  concurrency: Number(values.concurrency),
  minConfidence,
  usages: meter.usages,
});

console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
const failUnder = values["fail-under"];
if (failUnder !== undefined && report.intent.accuracy < Number(failUnder)) process.exit(1);
