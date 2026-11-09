import { Card, type CardProvider, type CardResult, parseCardRef } from "@cc/core";

/**
 * Cards (docs/CARDS.md): resolves the references agents write in ```card fences to live data
 * from the integration that owns the kind. Providers are read on every call, so an integration
 * connected or changed on the Accounts page is picked up without a restart.
 */
export class CardService {
  private readonly cache = new Map<string, { at: number; result: CardResult }>();

  constructor(
    /** Each integration's providers now, keyed by kind (`odoo.product`); the key's first part is the integration. */
    private readonly providers: () => Record<string, CardProvider>,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  /** The kinds on offer, optionally only those of the given integrations (a run's MCP servers). */
  kinds(integrations?: readonly string[]): { kind: string; description: string }[] {
    return Object.entries(this.providers())
      .filter(([kind]) => !integrations || integrations.includes(kind.split(".")[0]!))
      .map(([kind, p]) => ({ kind, description: p.description }));
  }

  /** One result per reference, in order. A card that can't be made is an error line, never a thrown request. */
  async resolve(refs: string[]): Promise<CardResult[]> {
    return Promise.all(refs.slice(0, 12).map((ref) => this.one(ref)));
  }

  private async one(ref: string): Promise<CardResult> {
    const now = (this.options.now ?? Date.now)();
    const hit = this.cache.get(ref);
    if (hit && now - hit.at < (this.options.ttlMs ?? 30_000)) return hit.result;
    const result = await this.lookup(ref);
    // Errors aren't kept: the record may be created, or the integration reconnected, a moment later.
    if ("card" in result) this.cache.set(ref, { at: now, result });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  private async lookup(ref: string): Promise<CardResult> {
    const parsed = parseCardRef(ref);
    if (!parsed) return { ref, error: "Not a card reference (expected kind:id, e.g. odoo.product:42)" };
    const provider = this.providers()[parsed.kind];
    if (!provider) return { ref, error: `No ${parsed.kind} cards (is ${parsed.kind.split(".")[0]} connected?)` };
    try {
      const data = await provider.resolve(parsed.id);
      if (!data) return { ref, error: `Nothing found for ${ref}` };
      const card = Card.parse({ ...data, ref, kind: parsed.kind });
      return { ref, card: { ...card, badges: card.badges.slice(0, 4), facts: card.facts.slice(0, 8) } };
    } catch (err) {
      return { ref, error: `Could not load ${ref}: ${(err as Error).message}` };
    }
  }
}

/** The system-prompt section telling an agent which cards it can show, or "" when it has none. */
export function cardGuide(kinds: { kind: string; description: string }[]): string {
  if (!kinds.length) return "";
  return [
    "## Cards",
    "When your answer is about a specific record, show it as a card: Dave sees a picture, the key facts and a link, read live by the app. Write a fenced block with the language `card` and one reference per line, where the record belongs in your reply:",
    "```card\n" + `${kinds[0]!.kind}:42` + "\n```",
    "Only the reference goes in the block: no JSON, no text. Use an id you got from a tool in this run. Up to 12 per block; don't repeat the card's facts as prose or a table (add only what the card can't show). Cards are not read aloud, so in a spoken answer say the facts as well. Kinds:",
    ...kinds.map((k) => `- \`${k.kind}:<id>\`: ${k.description}`),
  ].join("\n");
}
