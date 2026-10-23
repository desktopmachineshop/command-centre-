import type { Event, TriageResult, VerticalManifest } from "@cc/core";

export interface TriageContext {
  verticals: VerticalManifest[];
  defaultVertical: string;
}

/**
 * Decides which vertical an event belongs to, what it is about, how urgent it is
 * and how expensive a route it deserves. Returns null when it cannot decide.
 */
export interface Triager {
  readonly name: string;
  triage(event: Event, context: TriageContext): Promise<TriageResult | null>;
}

/**
 * Tries triagers in order (cheapest first) and takes the first result at or
 * above `minConfidence`; otherwise the most confident result seen.
 */
export class ChainTriager implements Triager {
  readonly name = "chain";

  constructor(
    private readonly triagers: Triager[],
    private readonly minConfidence = 0.7,
  ) {}

  async triage(event: Event, context: TriageContext): Promise<TriageResult | null> {
    let best: TriageResult | null = null;
    for (const triager of this.triagers) {
      const result = await triager.triage(event, context).catch(() => null);
      if (!result) continue;
      if (result.confidence >= this.minConfidence) return result;
      if (!best || result.confidence > best.confidence) best = result;
    }
    return best;
  }
}
