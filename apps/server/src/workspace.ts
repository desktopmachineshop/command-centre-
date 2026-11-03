import { existsSync, realpathSync } from "node:fs";
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
 *
 * Claude Code reads a skill's SKILL.md through the link, but any other file
 * the skill points to (e.g. video-reel/brands/dms.md) resolves into the bank,
 * outside the run's directory, where headless runs may not read. Pass
 * `skillReadRules` to the run's allowed tools to let it read its own skills.
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

  const wanted = new Set(linkedSkills(skillsDir, vertical, role));

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

/** The skills a run of this role (or of the vertical, without one) gets: listed and present in the bank. */
function linkedSkills(skillsDir: string, vertical: VerticalManifest, role?: Pick<Role, "skills">): string[] {
  const skills = role ? role.skills : vertical.skills;
  // A plain folder name only, so a listed skill can never point outside the bank.
  return [...new Set(skills)].filter((skill) => /^[\w-]+$/.test(skill) && existsSync(join(skillsDir, skill, "SKILL.md")));
}

/**
 * Read-only permission rules (`Read(//abs/path/**)`) for exactly the skill
 * folders linked into this run's workspace, so a skill's supporting files can
 * be read without opening the rest of the bank.
 */
export function skillReadRules(skillsDir: string, vertical: VerticalManifest, role?: Pick<Role, "skills">): string[] {
  return linkedSkills(skillsDir, vertical, role).map((skill) => `Read(/${realpathSync(join(skillsDir, skill))}/**)`);
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
