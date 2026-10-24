import type { Event, Route, VerticalManifest } from "@cc/core";
import type { TriageContext } from "./triager";

/** Token usage of one model triage call, reported through `onUsage` (for cost logs and the eval). */
export interface TriageUsage {
  triager: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the triager's configured per-million-token prices. */
  costUsd: number;
}

/** USD per million tokens. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Options every model-backed triager accepts. */
export interface ModelTriagerOptions {
  /** Abort the request after this many ms and return null. */
  timeoutMs?: number;
  /** Called once per successful call with its token usage. */
  onUsage?: (usage: TriageUsage) => void;
  /** Called when a call fails; the triager still returns null so the chain falls through. */
  onError?: (error: unknown) => void;
  /** Characters of event content sent to the model (default 6000). */
  maxChars?: number;
}

export function costOf(pricing: Pricing, inputTokens: number, outputTokens: number): number {
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}

/** Intents that mean "ignore this" when the triager is sure of them. */
export const NOISE_INTENTS = new Set(["spam"]);

/** Descriptions for the intents verticals use. Unknown intents fall back to their humanised id. */
export const INTENT_HINTS: Record<string, string> = {
  "presales-question": "A prospective customer asking about products, compatibility, specs, stock, price or shipping before buying",
  "order-status": "A customer asking where their order is, about tracking, delivery or dispatch of an existing order",
  "return-warranty": "A return, refund, exchange, damaged or faulty item, or warranty claim",
  supplier: "A supplier or manufacturer: stock, lead times, purchase orders, price lists, new products",
  "invoice-admin": "Invoices, bills, receipts, payments, tax, accounts and other business admin",
  spam: "Spam, phishing, SEO/marketing cold outreach, or unsolicited sales pitches",
  "content-idea": "An idea or suggestion for a blog post, video or social post",
  "comment-reply": "A comment or message on the blog, Instagram or YouTube that may need a reply",
  collab: "A collaboration, sponsorship, review-unit or partnership request",
  publishing: "Publishing logistics: scheduled posts, uploads, platform notices about published content",
  support: "A user needing help using the product",
  bug: "A report that something in the product is broken",
  "feature-request": "A request for a new feature or change",
  billing: "Subscription, payment or invoice questions for the product",
  plan: "Planning something: trips, events, purchases, schedules",
  reminder: "Something Dave needs to remember or do by a date: appointments, renewals, deadlines",
  question: "A question that needs an answer or a bit of research",
  admin: "Personal admin: bills, bank, insurance, utilities, government, household",
  // Odoo events (set by the rules triager from the event kind; see ./odoo.ts)
  "new-order": "A new confirmed sales or website order in Odoo",
  "customer-message": "A customer's message or helpdesk ticket on an Odoo record that may need a reply",
  "stock-low": "A product's stock fell below its reorder threshold",
  "delivery-late": "An outgoing delivery is past its scheduled date and not yet shipped",
  review: "A customer rating or product review",
  other: "None of the other intents fit",
};

export function intentHint(intent: string): string {
  return INTENT_HINTS[intent] ?? intent.replace(/[-_]+/g, " ");
}

/** The intents a triager may assign in a vertical: its declared intents plus "other". */
export function intentsFor(vertical: VerticalManifest): string[] {
  return [...new Set([...vertical.intents, "other"])];
}

/** The verticals a triager should choose from: just the known one when ingress already set it. */
export function candidateVerticals(event: Event, context: TriageContext): VerticalManifest[] {
  const known = event.vertical ? context.verticals.find((v) => v.id === event.vertical) : undefined;
  return known ? [known] : context.verticals;
}

const TEXT_FIELDS = ["from", "to", "subject", "text", "body", "snippet", "message"];

/**
 * Compact JSON-friendly view of an event for a model. Common text fields come first; the rest
 * of the payload follows. Long strings are cut so the whole state stays under `maxChars`.
 */
export function eventState(event: Event, maxChars = 6000): Record<string, unknown> {
  const state: Record<string, unknown> = { source: event.source, kind: event.kind, title: event.title };
  const payload = event.payload ?? {};
  for (const key of TEXT_FIELDS) if (payload[key] !== undefined) state[key] = payload[key];
  const rest = Object.fromEntries(Object.entries(payload).filter(([k]) => !TEXT_FIELDS.includes(k)));
  if (Object.keys(rest).length) state.payload = rest;
  return truncateStrings(state, maxChars);
}

function truncateStrings(state: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  let json = JSON.stringify(state);
  if (json.length <= maxChars) return state;
  // Cut the longest string field until it fits (or nothing long is left).
  const out = structuredClone(state);
  for (let i = 0; i < 20 && json.length > maxChars; i++) {
    const longest = longestString(out);
    if (!longest || longest.value.length < 200) break;
    const keep = Math.max(200, longest.value.length - (json.length - maxChars) - 20);
    longest.set(`${longest.value.slice(0, keep)}…`);
    json = JSON.stringify(out);
  }
  return out;
}

function longestString(node: unknown): { value: string; set: (v: string) => void } | undefined {
  let best: { value: string; set: (v: string) => void } | undefined;
  const visit = (value: unknown, set: (v: string) => void) => {
    if (typeof value === "string") {
      if (!best || value.length > best.value.length) best = { value, set };
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, (v) => (value[i] = v)));
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) visit(obj[key], (v) => (obj[key] = v));
    }
  };
  visit(node, () => {});
  return best;
}

/** Probability-style signals a model triager produced, used to pick the cheapest safe route. */
export interface RouteSignals {
  intent: string;
  /** Probability of the chosen intent. */
  intentP: number;
  /** Probability the event is spam / noise that needs no attention. */
  noise: number;
  /** Probability it is worth keeping but needs no reply or action. */
  fyi: number;
  /** Probability a small model can handle it without a full agent. */
  simple: number;
}

export interface RouteThresholds {
  /** Drop when a noise intent (e.g. spam) has at least this probability (default 0.8). */
  drop: number;
  /** Drop when the noise signal alone reaches this (default 0.9). */
  noise: number;
  /** File without action at this FYI probability (default 0.8). */
  file: number;
  /** Use the cheap agent at this probability that it's simple (default 0.7). */
  cheap: number;
}

export const DEFAULT_THRESHOLDS: RouteThresholds = { drop: 0.8, noise: 0.9, file: 0.8, cheap: 0.7 };

/** Cheapest route the signals justify: drop, then file, then cheap-agent, otherwise agent. */
export function chooseRoute(s: RouteSignals, t: RouteThresholds = DEFAULT_THRESHOLDS): Route {
  if ((NOISE_INTENTS.has(s.intent) && s.intentP >= t.drop) || s.noise >= t.noise) return "drop";
  if (s.fyi >= t.file) return "file";
  if (s.simple >= t.cheap) return "cheap-agent";
  return "agent";
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
