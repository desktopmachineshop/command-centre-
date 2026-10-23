# Skills bank

Shared skills for every agent type, in the [Agent Skills](https://agentskills.io) format:
one folder per skill with a `SKILL.md` (YAML frontmatter `name` + `description`, then
instructions) and any supporting scripts or reference files.

- **Claude Code** discovers them natively: before each run the server symlinks the run's role's
  skills (see `docs/ORG.md`) into `<workspace>/.claude/skills/`.
- **Other agents** (AI SDK runners, later phases) get the same files injected as context.

A vertical opts into a skill by listing its folder name in `skills` in its manifest
(`packages/verticals/src/*.ts`), and each role lists the subset (plus any role-specific skills)
its workspace gets. Keep skills vertical-agnostic where possible, and put
vertical-specific facts in the brain, not in the skill.
