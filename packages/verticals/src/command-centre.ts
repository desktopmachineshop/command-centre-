import { defineVertical } from "@cc/core";

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
  mcpServers: ["brain"],
  policies: { "brain.write": "auto" },
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
      mcpServers: ["brain"],
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"],
      repo: "desktopmachineshop/command-centre-",
      actions: ["github.pr.create", "brain.write", "notify"],
      kpis: ["Each PR is green in CI when raised", "Changes are small, with tests", "Dave can merge without rework"],
      autonomyNotes:
        "Edits, builds and commits freely inside its own checkout. Pushing a branch and opening or updating a pull request (github.pr.create) waits for Dave's approval. Never merges, never pushes to the default branch, never changes secrets or production settings.",
    },
  ],
});
