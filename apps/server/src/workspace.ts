import { existsSync } from "node:fs";
import { mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { VerticalManifest } from "@cc/core";

/**
 * Prepares the working directory for a vertical's agent runs. Claude Code
 * discovers skills in `<cwd>/.claude/skills`, so the vertical's skills from the
 * shared bank are symlinked there and nothing else is visible.
 *
 * Runs in one vertical can overlap, so this never wipes the folder: it adds
 * missing links, fixes wrong ones and removes entries the vertical no longer has.
 */
export async function prepareWorkspace(dataDir: string, skillsDir: string, vertical: VerticalManifest): Promise<string> {
  const cwd = join(dataDir, "workspaces", vertical.id);
  const skillsTarget = join(cwd, ".claude", "skills");
  await mkdir(skillsTarget, { recursive: true });

  const available = existsSync(skillsDir)
    ? new Set((await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name))
    : new Set<string>();
  const wanted = new Set(vertical.skills.filter((skill) => available.has(skill) && existsSync(join(skillsDir, skill, "SKILL.md"))));

  for (const entry of await readdir(skillsTarget)) {
    if (!wanted.has(entry)) await rm(join(skillsTarget, entry), { recursive: true, force: true });
  }
  for (const skill of wanted) {
    const target = join(skillsDir, skill);
    const link = join(skillsTarget, skill);
    if (await linkTo(target, link)) continue;
    // Something else is there (an old link or a copied folder): replace it.
    if ((await readlink(link).catch(() => null)) === target) continue;
    await rm(link, { recursive: true, force: true });
    await linkTo(target, link);
  }
  return cwd;
}

/** Creates the symlink; false if the path already exists (possibly made by a concurrent run). */
async function linkTo(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, "dir");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
