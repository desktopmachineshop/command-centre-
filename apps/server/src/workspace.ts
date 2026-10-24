import { existsSync } from "node:fs";
import { mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Role, VerticalManifest } from "@cc/core";

/**
 * Prepares the working directory for agent runs. Claude Code discovers skills
 * in `<cwd>/.claude/skills`, so the skills from the shared bank are symlinked
 * there and nothing else is visible. With a role the folder is
 * `workspaces/<vertical>/<role>` and holds only the role's skills; without one
 * it is `workspaces/<vertical>` with the vertical's skills.
 *
 * Runs of one role can overlap, so this never wipes the folder: it adds
 * missing links, fixes wrong ones and removes entries the role no longer has.
 */
export async function prepareWorkspace(
  dataDir: string,
  skillsDir: string,
  vertical: VerticalManifest,
  role?: Pick<Role, "id" | "skills">,
): Promise<string> {
  const verticalDir = join(dataDir, "workspaces", vertical.id);
  const cwd = role ? join(verticalDir, role.id) : verticalDir;
  const skillsTarget = join(cwd, ".claude", "skills");
  await mkdir(skillsTarget, { recursive: true });
  // Skills linked at the vertical level (before roles) sit in a parent of every role
  // folder, where Claude Code could still find them: remove them.
  if (role) await rm(join(verticalDir, ".claude"), { recursive: true, force: true });

  const available = existsSync(skillsDir)
    ? new Set((await readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name))
    : new Set<string>();
  const skills = role ? role.skills : vertical.skills;
  const wanted = new Set(skills.filter((skill) => available.has(skill) && existsSync(join(skillsDir, skill, "SKILL.md"))));

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
