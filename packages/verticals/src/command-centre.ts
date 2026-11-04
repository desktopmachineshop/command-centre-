import { defineVertical } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "./policies";

/**
 * The command centre itself: the app, server, agents and skills in
 * desktopmachineshop/command-centre-. Its Software Lead codes in a checkout
 * of that repo and raises pull requests Dave approves.
 */
export default defineVertical({
  id: "command-centre",
  name: "Command Centre",
  description: "This app: the server, the PWA, the agents and their skills (desktopmachineshop/command-centre-).",
  brainFolder: "command-centre",
  color: "#6e56cf",
  intents: ["software"],
  skills: ["brain-notes", "software-lead"],
  // github: read-only pull requests, CI and issues (mounted while GITHUB_TOKEN is set).
  mcpServers: ["brain", "github"],
  // Raising or updating a PR changes nothing until it is merged, so only merging waits for Dave.
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "github.pr.create": "auto" },
  roles: [
    {
      id: "software-lead",
      title: "Software Lead",
      reportsTo: "chief-of-staff",
      aliases: ["software", "dev", "developer", "engineering", "coder"],
      mission:
        "Builds and fixes the Command Centre: reads the code, makes the change on a branch in its own checkout, runs the checks, and raises a pull request for Dave to review and merge. Keeps changes small, tested and explained.",
      intents: ["software"],
      skills: ["brain-notes", "software-lead"],
      mcpServers: ["brain", "github"],
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"],
      // Reading code, editing several files and running the checks takes far more than the default 30 turns.
      maxTurns: 200,
      repo: "desktopmachineshop/command-centre-",
      actions: ["github.pr.create", "github.pr.merge", "brain.write", "notify"],
      kpis: ["Each PR is green in CI when raised", "Changes are small, with tests", "Dave can merge without rework"],
      autonomyNotes:
        "Edits, builds and commits freely inside its own checkout, and pushes a branch and opens or updates its pull request (github.pr.create) without asking. Merging (github.pr.merge) always waits for Dave's approval. Never pushes to the default branch, never changes secrets or production settings.",
    },
  ],
});
