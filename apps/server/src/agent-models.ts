import { GEMINI_API, GEMINI_DEFAULT_MODEL } from "@cc/agent-runtime";
import type { AgentProvider } from "@cc/core";
import { type Config, parseAgentRoute } from "./config";

export interface ModelOption {
  /** What the runner is given ("sonnet", "gemini-2.5-flash"); "" = the provider's default. */
  id: string;
  label: string;
}

export interface ProviderModels {
  id: AgentProvider;
  label: string;
  /** An account is set up for it (a token, sign-in or key); it may still be at its limit. */
  connected: boolean;
  /** Where it sits in the agent route (0 = first), or null when the route doesn't use it. */
  routeIndex: number | null;
  models: ModelOption[];
}

export interface AgentModels {
  route: AgentProvider[];
  providers: ProviderModels[];
}

/**
 * The model choices Claude Code takes as `--model`: its aliases, which follow Anthropic's
 * current models, so the list doesn't go stale.
 */
const CLAUDE_MODELS: ModelOption[] = [
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
];
/** Codex on a ChatGPT plan has no model list to ask for; these are names it accepts. */
const CODEX_MODELS: ModelOption[] = [
  { id: "gpt-5-codex", label: "GPT-5 Codex" },
  { id: "gpt-5", label: "GPT-5" },
];
/** Shown when the Gemini model list can't be fetched. */
const GEMINI_MODELS: ModelOption[] = [
  { id: "gemini-pro-latest", label: "Gemini Pro (latest)" },
  { id: "gemini-flash-latest", label: "Gemini Flash (latest)" },
  { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite (latest)" },
];

const LIVE_TTL_MS = 10 * 60_000;

/**
 * The providers and models the chat's model picker and a specialist's setting offer. Gemini's list
 * comes from the Gemini API with the saved key (cached for ten minutes); the others are fixed.
 */
export class AgentModelCatalog {
  private cache: { key: string; at: number; models: ModelOption[] } | null = null;

  constructor(
    private readonly config: () => Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly geminiApi: string = GEMINI_API,
  ) {}

  async list(): Promise<AgentModels> {
    const a = this.config().agent;
    const route = parseAgentRoute(a.route) ?? ["claude"];
    const at = (id: AgentProvider) => (route.includes(id) ? route.indexOf(id) : null);
    const withDefault = (label: string, models: ModelOption[]) => [{ id: "", label }, ...models];
    return {
      route,
      providers: [
        { id: "claude", label: "Claude", connected: !!a.oauthToken || !!a.fallbackApiKey, routeIndex: at("claude"), models: withDefault("Claude (default)", CLAUDE_MODELS) },
        {
          id: "codex",
          label: "ChatGPT (Codex)",
          connected: !!a.codexAuth,
          routeIndex: at("codex"),
          models: withDefault(a.codexModel ? `Codex (${a.codexModel})` : "Codex (plan default)", uniq([...(a.codexModel ? [{ id: a.codexModel, label: a.codexModel }] : []), ...CODEX_MODELS])),
        },
        {
          id: "gemini",
          label: "Gemini (Google AI Studio)",
          connected: !!a.geminiApiKey,
          routeIndex: at("gemini"),
          models: withDefault(`Gemini (${a.geminiModel || GEMINI_DEFAULT_MODEL})`, a.geminiApiKey ? await this.gemini(a.geminiApiKey) : GEMINI_MODELS),
        },
      ],
    };
  }

  /** The key's Gemini models that can chat (generateContent), newest names first; the fixed list if the API can't be reached. */
  private async gemini(key: string): Promise<ModelOption[]> {
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < LIVE_TTL_MS) return this.cache.models;
    try {
      const res = await this.fetchImpl(`${this.geminiApi}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return GEMINI_MODELS;
      const body = (await res.json()) as { models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
      const live = (body.models ?? [])
        .filter((m) => m.name?.startsWith("models/gemini") && m.supportedGenerationMethods?.includes("generateContent"))
        .filter((m) => !/embedding|tts|image|audio|live/i.test(m.name!))
        .map((m) => ({ id: m.name!.slice("models/".length), label: m.displayName || m.name!.slice("models/".length) }))
        .sort((x, y) => y.id.localeCompare(x.id));
      const models = uniq([...GEMINI_MODELS, ...live]);
      this.cache = { key, at: Date.now(), models };
      return models;
    } catch {
      return GEMINI_MODELS;
    }
  }
}

function uniq(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return models.filter((m) => !seen.has(m.id) && seen.add(m.id));
}
