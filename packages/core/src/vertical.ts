import { z } from "zod";
import { Policy } from "./domain";

export const Schedule = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Standard 5-field cron expression, evaluated in `timezone`. */
  cron: z.string(),
  timezone: z.string().default("Europe/London"),
  /** Prompt handed to the command agent when the schedule fires. */
  prompt: z.string(),
  enabled: z.boolean().default(true),
});
export type Schedule = z.infer<typeof Schedule>;

/**
 * A vertical is a business, side project or life area the command centre manages.
 * Adding a vertical means adding one manifest; nothing else in the core changes.
 */
export const VerticalManifest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string(),
  /** Folder inside the brain repo that holds this vertical's notes. */
  brainFolder: z.string(),
  /** Intents the triager may assign to events in this vertical. "other" is always allowed. */
  intents: z.array(z.string()).default([]),
  /** Skill names from the shared skills bank this vertical's agents may use. */
  skills: z.array(z.string()).default([]),
  /** Names of MCP servers (from the server's MCP registry) this vertical's agents get. */
  mcpServers: z.array(z.string()).default([]),
  schedules: z.array(Schedule).default([]),
  /** Per action type autonomy. Anything unlisted uses `defaultPolicy`. */
  policies: z.record(z.string(), Policy).default({}),
  defaultPolicy: Policy.default("draft"),
});
export type VerticalManifest = z.infer<typeof VerticalManifest>;
export type VerticalManifestInput = z.input<typeof VerticalManifest>;

export function defineVertical(input: VerticalManifestInput): VerticalManifest {
  return VerticalManifest.parse(input);
}

export function policyFor(vertical: VerticalManifest, actionType: string): Policy {
  return vertical.policies[actionType] ?? vertical.defaultPolicy;
}
