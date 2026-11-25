import type { AgentChoice, AgentProvider } from "@cc/core";
import { useEffect, useState } from "react";
import type { AgentModels, Api } from "./api";

/** The picker's value: "" = the agent route as it is, else "provider:model" (model may be empty). */
export const choiceValue = (choice: AgentChoice | null | undefined): string => (choice ? `${choice.provider}:${choice.model ?? ""}` : "");

export function choiceOf(value: string): AgentChoice | undefined {
  if (!value) return undefined;
  const i = value.indexOf(":");
  const provider = (i < 0 ? value : value.slice(0, i)) as AgentProvider;
  const model = i < 0 ? "" : value.slice(i + 1);
  return { provider, ...(model ? { model } : {}) };
}

/** The providers and models, fetched once per page load and shared by every picker on it. */
let shared: Promise<AgentModels> | null = null;
export function useAgentModels(api: Api): AgentModels | null {
  const [models, setModels] = useState<AgentModels | null>(null);
  useEffect(() => {
    let live = true;
    shared ??= api.agentModels().catch((err) => {
      shared = null;
      throw err;
    });
    shared.then((m) => live && setModels(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  return models;
}

/**
 * One dropdown of models grouped by provider (Claude, ChatGPT, Gemini), plus "Auto" for the agent
 * route as set on the Accounts page. The pick goes first; the route still takes over if that
 * provider isn't available. A saved pick the list no longer has stays selectable.
 */
export function ModelPicker({
  api,
  value,
  onChange,
  autoLabel = "Auto (agent route)",
  className,
  id,
  ...rest
}: {
  api: Api;
  value: AgentChoice | null | undefined;
  onChange: (choice: AgentChoice | undefined) => void;
  autoLabel?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "data-help-key"?: string;
}) {
  const models = useAgentModels(api);
  const current = choiceValue(value);
  const known = new Set(models?.providers.flatMap((p) => p.models.map((m) => `${p.id}:${m.id}`)) ?? []);
  return (
    <select id={id} className={className} value={current} onChange={(e) => onChange(choiceOf(e.target.value))} {...rest}>
      <option value="">{autoLabel}</option>
      {current && !known.has(current) && <option value={current}>{value?.model ? `${value.provider}: ${value.model}` : value?.provider}</option>}
      {models?.providers.map((p) => (
        <optgroup key={p.id} label={`${p.label}${p.connected ? "" : " (not connected)"}`}>
          {p.models.map((m) => (
            <option key={m.id} value={`${p.id}:${m.id}`}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
