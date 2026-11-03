import { z } from "zod";
import type { Capability, WorkerNode } from "./domain";

/**
 * Device roles: what a computer is for (media production, local Claude Code), and the software
 * each needs. The Devices page shows every role under a computer, with what's installed and
 * what's missing, and a one-click **Install** that hands the computer a `setup.install` job.
 *
 * The worker installs only from this list: the job names components, never commands or package
 * ids, so nothing the server sends can install anything else. Components that can't be installed
 * by a package manager are shown with a link (DaVinci Resolve needs a Blackmagic sign-up) or as
 * hardware (a graphics card).
 */

export const SetupComponentId = z.enum(["ffmpeg", "browser", "gpu", "davinci", "git", "claude-code"]);
export type SetupComponentId = z.infer<typeof SetupComponentId>;

export type SetupInstall =
  /** Installed with `winget install --id <id> --exact` on Windows. */
  | { kind: "winget"; id: string }
  /** Installed by hand: the page links to it. */
  | { kind: "manual"; url: string }
  /** Can't be installed: it's part of the computer. */
  | { kind: "hardware" };

export interface SetupComponent {
  id: SetupComponentId;
  label: string;
  /** What it's for, in a few words. */
  why: string;
  /** The capability it gives the computer (its jobs need it), if any. */
  capability?: Capability;
  install: SetupInstall;
  /** Nice to have: a role counts as ready without it. */
  optional?: boolean;
}

export const SETUP_COMPONENTS: Record<SetupComponentId, SetupComponent> = {
  ffmpeg: { id: "ffmpeg", label: "ffmpeg", why: "renders and converts video", capability: "ffmpeg", install: { kind: "winget", id: "Gyan.FFmpeg" } },
  browser: {
    id: "browser",
    label: "Chrome",
    why: "screen capture for walkthrough videos (Edge works too)",
    capability: "browser",
    install: { kind: "winget", id: "Google.Chrome" },
  },
  gpu: { id: "gpu", label: "Graphics card", why: "faster renders", capability: "gpu", install: { kind: "hardware" }, optional: true },
  davinci: {
    id: "davinci",
    label: "DaVinci Resolve",
    why: "editing projects (free download after a Blackmagic sign-up)",
    capability: "davinci",
    install: { kind: "manual", url: "https://www.blackmagicdesign.com/products/davinciresolve" },
    optional: true,
  },
  git: { id: "git", label: "Git", why: "Claude Code needs it on Windows", install: { kind: "winget", id: "Git.Git" } },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    why: "runs local Claude Code jobs",
    capability: "claude-local",
    install: { kind: "winget", id: "Anthropic.ClaudeCode" },
  },
};

export const SetupRoleId = z.enum(["media", "claude"]);
export type SetupRoleId = z.infer<typeof SetupRoleId>;

export interface SetupRole {
  id: SetupRoleId;
  label: string;
  description: string;
  components: SetupComponentId[];
}

export const SETUP_ROLES: SetupRole[] = [
  {
    id: "media",
    label: "Media production",
    description: "Video renders, screen capture and editing for OpenV and OpenD content.",
    components: ["ffmpeg", "browser", "gpu", "davinci"],
  },
  {
    id: "claude",
    label: "Local Claude Code",
    description: "Claude Code sessions on this computer, in folders you allow.",
    components: ["git", "claude-code"],
  },
];

/** What a worker reports about its own setup (in its hello, and again after installing). */
export const NodeSetup = z.object({
  /** `process.platform`: win32, darwin, linux. */
  platform: z.string().max(32),
  /** The package manager it can install with; null when it can't install anything itself. */
  installer: z.enum(["winget"]).nullable(),
  installed: z.array(SetupComponentId),
});
export type NodeSetup = z.infer<typeof NodeSetup>;

/**
 * - `installed`: it's there.
 * - `missing`: not there, and the Install button can add it.
 * - `manual`: not there; install it yourself (the page links to it).
 * - `unavailable`: not there and can't be installed from here (no graphics card, or no installer on this computer).
 * - `unknown`: an older worker that doesn't report setup, for a component without a capability.
 */
export type ComponentState = "installed" | "missing" | "manual" | "unavailable" | "unknown";

export interface ComponentStatus {
  component: SetupComponent;
  state: ComponentState;
}

export interface RoleStatus {
  role: SetupRole;
  components: ComponentStatus[];
  /** Components the Install button would install now. */
  installable: SetupComponentId[];
  /** Everything it needs (optional components aside) is installed. */
  ready: boolean;
}

type NodeLike = Pick<WorkerNode, "capabilities"> & { setup?: NodeSetup | null };

/** Whether a component is on a computer. Older workers don't report setup: fall back to capabilities. */
function isInstalled(c: SetupComponent, node: NodeLike): boolean {
  if (node.setup) return node.setup.installed.includes(c.id);
  return !!c.capability && node.capabilities.includes(c.capability);
}

export function componentState(c: SetupComponent, node: NodeLike): ComponentState {
  if (isInstalled(c, node)) return "installed";
  if (!node.setup && !c.capability) return "unknown";
  if (c.install.kind === "hardware") return "unavailable";
  if (c.install.kind === "manual") return "manual";
  return node.setup?.installer === c.install.kind ? "missing" : "unavailable";
}

export function roleStatus(role: SetupRole, node: NodeLike): RoleStatus {
  const components = role.components.map((id) => {
    const component = SETUP_COMPONENTS[id];
    return { component, state: componentState(component, node) };
  });
  return {
    role,
    components,
    installable: components.filter((c) => c.state === "missing").map((c) => c.component.id),
    ready: components.every((c) => c.state === "installed" || c.component.optional),
  };
}

/** The winget package id of each component in `ids` that winget installs (others are dropped). */
export function wingetPackages(ids: readonly string[]): { component: SetupComponentId; id: string }[] {
  const out: { component: SetupComponentId; id: string }[] = [];
  for (const raw of ids) {
    const parsed = SetupComponentId.safeParse(raw);
    if (!parsed.success) continue;
    const install = SETUP_COMPONENTS[parsed.data].install;
    if (install.kind === "winget" && !out.some((o) => o.component === parsed.data)) out.push({ component: parsed.data, id: install.id });
  }
  return out;
}
