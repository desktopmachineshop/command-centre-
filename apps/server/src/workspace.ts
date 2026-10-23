import { existsSync } from "node:fs";
import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { VerticalManifest } from "@cc/core";

/**
 * Prepares the working directory for a vertical's agent runs. Claude Code
 * discovers skills in `<cwd>/.claude/skills`, so the vertical's skills from the
 * shared bank are symlinked there and nothing else is visible.
 */
export async function prepareWorkspace(dataDir: string, skillsDir: string, vertical: VerticalManifest): Promise<string> {
  const cwd = join(dataDir, "workspaces", vertical.id);
  const skillsTarget = join(cwd, ".claude", "skills");
  await rm(skillsTarget, { recursive: true, force: true });
  await mkdir(skillsTarget, { recursive: true });

  const available = existsSync(skillsDir)
    ? new Set((await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name))
    : new Set<string>();
  for (const skill of vertical.skills) {
    if (available.has(skill) && existsSync(join(skillsDir, skill, "SKILL.md"))) {
      await symlink(join(skillsDir, skill), join(skillsTarget, skill), "dir");
    }
  }
  return cwd;
}
