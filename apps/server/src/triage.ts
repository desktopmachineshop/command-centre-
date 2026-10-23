import { AnthropicTriager, ChainTriager, JevTriager, RulesTriager, type Triager } from "@cc/triage";
import type { Config } from "./config";

/**
 * The triage chain, cheapest first: rules, then Jev and the Haiku classifier when their keys
 * are set. Model triagers fail soft (null), so an outage falls through to the next one.
 */
export function createTriager(config: Config, log: Pick<Console, "warn"> = console): Triager {
  const { triage } = config;
  const onError = (name: string) => (error: unknown) =>
    log.warn(`[triage] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  const chain: Triager[] = [new RulesTriager()];
  if (triage.jevApiKey) {
    chain.push(new JevTriager({ apiKey: triage.jevApiKey, baseUrl: triage.jevBaseUrl, model: triage.jevModel, onError: onError("jev") }));
  }
  if (triage.anthropicApiKey) {
    chain.push(new AnthropicTriager({ apiKey: triage.anthropicApiKey, onError: onError("haiku") }));
  }
  return new ChainTriager(chain, triage.minConfidence);
}
