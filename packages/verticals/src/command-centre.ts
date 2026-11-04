import { defineVertical } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "./policies";

/** Weekdays 18:07: triage the brain's issue log and file what's new on GitHub. */
const FILE_ISSUES = `Work through the brain's central issue log and file it on GitHub. Follow the software-lead skill, section "The issue log".

1. Sweep: search the brain (search, list) for bugs or faults recorded outside issues/: notes or sections describing something broken in the Command Centre, its agents or integrations. Record each with report_issue (one per problem, with category, agent and severity), then remove it from where it was (rewrite that note without it, or replace the note with a one-line pointer to the issue). The server already moves whole notes typed or tagged as issues.
2. Triage: list_issues, and for each one marked "needs triage" read the note and, where useful, the code, then update_issue with the right category, agent (a role id, or "none") and severity, and triaged: true. Merge duplicates: mark the newer one duplicate with a note naming the other.
3. Sync: for issues already on GitHub (GitHub #n), read the GitHub issue (github tool issue). If it is closed, update_issue status fixed (or wont-fix if it was closed as not planned).
4. File: list_issues with unfiled: true. Skip any still needing triage. Check the GitHub tool list_issues for an open issue that already covers it; if one does, update_issue with a note naming it instead of filing. Otherwise propose github.issue.create with { path } for each, most severe first, at most 10 per run.

Do not change code in this run. Finish with a short report: what you moved, triaged, synced and filed (with GitHub numbers), and anything that needs Dave.`;

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
  // Filing an issue from the brain's issue log only records it in Dave's own repository.
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "github.pr.create": "auto", "github.issue.create": "auto" },
  roles: [
    {
      id: "software-lead",
      title: "Software Lead",
      reportsTo: "chief-of-staff",
      aliases: ["software", "dev", "developer", "engineering", "coder"],
      mission:
        "Builds and fixes the Command Centre: reads the code, makes the change on a branch in its own checkout, runs the checks, and raises a pull request for Dave to review and merge. Keeps changes small, tested and explained. Owns the brain's central issue log: triages it and files the issues on GitHub.",
      intents: ["software"],
      skills: ["brain-notes", "software-lead"],
      mcpServers: ["brain", "github"],
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"],
      // Reading code, editing several files and running the checks takes far more than the default 30 turns.
      maxTurns: 200,
      repo: "desktopmachineshop/command-centre-",
      actions: ["github.pr.create", "github.pr.merge", "github.issue.create", "brain.write", "notify"],
      schedules: [{ id: "file-issues", cron: "7 18 * * 1-5", timezone: "Europe/London", prompt: FILE_ISSUES, enabled: true }],
      kpis: ["Each PR is green in CI when raised", "Changes are small, with tests", "Dave can merge without rework"],
      autonomyNotes:
        "Edits, builds and commits freely inside its own checkout, and pushes a branch and opens or updates its pull request (github.pr.create) without asking, and files issues from the brain's issue log on GitHub (github.issue.create). Merging (github.pr.merge) always waits for Dave's approval. Never pushes to the default branch, never changes secrets or production settings.",
    },
  ],
});
