import type { Event, TriageResult, VerticalManifest } from "@cc/core";
import { z } from "zod";
import {
  DEFAULT_THRESHOLDS,
  type ModelTriagerOptions,
  type Pricing,
  type RouteThresholds,
  candidateVerticals,
  chooseRoute,
  clamp01,
  costOf,
  eventState,
  intentHint,
  intentsFor,
} from "./shared";
import type { TriageContext, Triager } from "./triager";

export interface JevTriagerOptions extends ModelTriagerOptions {
  apiKey: string;
  /** Default https://api.typesafe.ai (or a LiteLLM proxy's `/typesafe` path). */
  baseUrl?: string;
  /** Model name or alias, e.g. "jev-latest" (default) or a pinned "jev-1.13.0". */
  model?: string;
  fetch?: typeof fetch;
  /** Route thresholds; see `chooseRoute`. */
  thresholds?: Partial<RouteThresholds>;
  /** Default $0.04 per million input and output tokens. */
  pricing?: Pricing;
}

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";
/** Input price is published (~$0.04/M); the output price is an assumption. */
export const JEV_DEFAULT_PRICING: Pricing = { inputPerMTok: 0.04, outputPerMTok: 0.04 };

/**
 * Triage with TypeSafe Jev, a decision model: one `POST /v1/systemone` call asks typed
 * questions about the event and gets back probabilities.
 *
 * - `vertical`: Choice over the verticals (skipped when ingress already set one);
 * - `intent`: Choice over every "vertical/intent" pair. Jev answers questions independently,
 *   so one joint Choice stands in for "intent given vertical"; the chosen vertical's slice is
 *   renormalised;
 * - `urgency`: Score on a five-level scale, mapped to 0..1;
 * - `noise`, `fyi`, `simple`: Nouls that pick the route (drop, file, cheap-agent, agent).
 *
 * Confidence is min(P(vertical), P(intent | vertical)). Any error or timeout returns null.
 */
export class JevTriager implements Triager {
  readonly name = "jev";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetch: typeof fetch;
  private readonly thresholds: RouteThresholds;

  constructor(private readonly options: JevTriagerOptions) {
    this.baseUrl = (options.baseUrl || JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model || JEV_DEFAULT_MODEL;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  }

  async triage(event: Event, context: TriageContext): Promise<TriageResult | null> {
    try {
      const verticals = candidateVerticals(event, context);
      if (!verticals.length) return null;
      const request = buildJevRequest(event, verticals, this.model, this.options.maxChars);
      const response = await callJev(request, {
        url: `${this.baseUrl}/v1/systemone`,
        apiKey: this.options.apiKey,
        fetch: this.fetch,
        timeoutMs: this.options.timeoutMs ?? 10_000,
      });
      const { usage } = response;
      this.options.onUsage?.({
        triager: this.name,
        model: response.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        costUsd: costOf(this.options.pricing ?? JEV_DEFAULT_PRICING, usage.input_tokens, usage.output_tokens),
      });
      return mapJevAnswers(response, verticals, this.thresholds);
    } catch (error) {
      this.options.onError?.(error);
      return null;
    }
  }
}

// --- Wire format (https://docs.typesafe.ai/api/system-one) ---------------------------------

/** Separator between vertical and intent in the joint intent Choice's option keys. */
const SEP = "/";

const URGENCY_LEVELS = [
  "Whenever: no time pressure, informational",
  "This week: should be handled in the next few days",
  "Soon: within a day, e.g. a customer waiting on an answer before buying",
  "Today: a customer problem, a delayed or wrong order, a payment due",
  "Now: something is broken or money or reputation is at risk right now",
];

export interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, Record<string, unknown>>;
}

export function buildJevRequest(event: Event, verticals: VerticalManifest[], model: string, maxChars?: number): JevRequest {
  const questions: JevRequest["questions"] = {};
  if (verticals.length > 1) {
    questions.vertical = {
      type: "choice",
      instructions: "Which of Dave's businesses or life areas does this message belong to?",
      criteria: Object.fromEntries(verticals.map((v) => [v.id, `${v.name}: ${v.description}`])),
    };
  }
  questions.intent = {
    type: "choice",
    instructions: "What is this message about? Options are grouped by business as business/intent.",
    criteria: Object.fromEntries(
      verticals.flatMap((v) => intentsFor(v).map((i) => [`${v.id}${SEP}${i}`, `${v.name}: ${intentHint(i)}`])),
    ),
  };
  questions.urgency = {
    type: "score",
    instructions: "How soon does Dave need to deal with this?",
    criteria: URGENCY_LEVELS,
  };
  questions.noise = {
    type: "noul",
    instructions: "This is spam, phishing, cold marketing or automated noise that needs no attention at all.",
    criteria: { true: "Junk nobody needs to read", false: "A real person or a service Dave uses, saying something relevant" },
  };
  questions.fyi = {
    type: "noul",
    instructions: "This is worth keeping for the record, but needs no reply and no action.",
    criteria: {
      true: "A receipt, confirmation, statement or notice to file",
      false: "Someone is waiting for a reply, or something needs doing",
    },
  };
  questions.simple = {
    type: "noul",
    instructions:
      "This can be handled with a short reply from order data, product data or published policy, with no investigation or judgement call.",
  };
  return { model, state: eventState(event, maxChars), questions };
}

const Usage = z.object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) });
const Choice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().nullish(),
  probabilities: z.record(z.string(), z.number()).default({}),
});
const Score = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number().nullish(),
  probabilities: z.record(z.string(), z.number()).default({}),
});
const Noul = z.object({ type: z.literal("noul"), noul: z.number() });

export const JevResponse = z.object({
  model: z.string().default(JEV_DEFAULT_MODEL),
  answers: z.object({
    vertical: Choice.optional(),
    intent: Choice,
    urgency: Score.optional(),
    noise: Noul.optional(),
    fyi: Noul.optional(),
    simple: Noul.optional(),
  }),
  usage: Usage.default({ input_tokens: 0, output_tokens: 0 }),
});
export type JevResponse = z.infer<typeof JevResponse>;

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

/** POSTs one System One request. Throws JevError on HTTP errors, bad bodies and timeouts. */
export async function callJev(
  request: JevRequest,
  opts: { url: string; apiKey: string; fetch: typeof fetch; timeoutMs: number },
): Promise<JevResponse> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  try {
    res = await opts.fetch(opts.url, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    throw new JevError(signal.aborted ? `Jev timed out after ${opts.timeoutMs}ms` : `Jev request failed: ${String(error)}`);
  }
  // Error bodies can echo the submitted state, so keep them out of the message.
  if (!res.ok) throw new JevError(`Jev returned HTTP ${res.status}`, res.status);
  const parsed = JevResponse.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new JevError("Jev returned an unexpected response body");
  return parsed.data;
}

/** Turns Jev's answers into a TriageResult. */
export function mapJevAnswers(
  response: JevResponse,
  verticals: VerticalManifest[],
  thresholds: RouteThresholds = DEFAULT_THRESHOLDS,
): TriageResult | null {
  const { answers } = response;
  const jointP = (key: string) => answers.intent.probabilities[key] ?? (key === answers.intent.choice ? 1 : 0);

  // Vertical: its own Choice when asked, else the only candidate; fall back to the intent's prefix.
  let verticalId: string | undefined;
  let verticalP = 1;
  if (verticals.length === 1) {
    verticalId = verticals[0]!.id;
  } else if (answers.vertical) {
    verticalId = answers.vertical.choice;
    verticalP = answers.vertical.probabilities[verticalId] ?? answers.vertical.confidence ?? 0;
  } else {
    verticalId = answers.intent.choice.split(SEP)[0];
    const v = verticals.find((x) => x.id === verticalId);
    verticalP = v ? intentsFor(v).reduce((sum, i) => sum + jointP(`${v.id}${SEP}${i}`), 0) : 0;
  }
  const vertical = verticals.find((v) => v.id === verticalId);
  if (!vertical) return null;

  // Intent: argmax of the joint Choice within the chosen vertical, renormalised.
  const options = intentsFor(vertical).map((i) => ({ intent: i, p: jointP(`${vertical.id}${SEP}${i}`) }));
  const mass = options.reduce((sum, o) => sum + o.p, 0);
  const best = options.reduce((a, b) => (b.p > a.p ? b : a));
  const intent = mass > 0 ? best.intent : "other";
  const intentP = mass > 0 ? best.p / mass : 0;

  const urgency = answers.urgency ? clamp01(answers.urgency.score / (URGENCY_LEVELS.length - 1)) : 0.3;
  const signals = {
    intent,
    intentP,
    noise: answers.noise?.noul ?? 0,
    fyi: answers.fyi?.noul ?? 0,
    simple: answers.simple?.noul ?? 0,
  };
  const f = (n: number) => n.toFixed(2);
  return {
    vertical: vertical.id,
    intent,
    urgency,
    route: chooseRoute(signals, thresholds),
    confidence: clamp01(Math.min(verticalP, intentP)),
    triager: "jev",
    notes: `${response.model}: P(vertical)=${f(verticalP)} P(intent)=${f(intentP)} noise=${f(signals.noise)} fyi=${f(signals.fyi)} simple=${f(signals.simple)}`,
  };
}
