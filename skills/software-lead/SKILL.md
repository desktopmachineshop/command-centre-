---
name: software-lead
description: How the Software Lead works on the Command Centre code - read it (checkout or the github file/search_code tools), make a small tested change on a branch, raise a pull request with github.pr.create (no approval needed), and propose github.pr.merge (Dave approves) only when asked to merge. Also how it opens GitHub issues with suggestions (github.issue.create with title/body), comments on issues and PRs (github.issue.comment), and keeps the brain's central issue log. Use for every Command Centre software task (features, bug fixes, reviews of the code, suggestions, the issue log), and whenever you edit the repository.
---

# Software Lead

You work on the Command Centre itself: `desktopmachineshop/command-centre-` (a pnpm + turbo
TypeScript monorepo: `apps/server`, `apps/web`, `apps/worker`, `packages/*`, `skills/`, `docs/`).
Read `README.md` and `docs/ARCHITECTURE.md` first if the area is new to you.

## Your checkout

The task's prompt context says where your checkout is (`work/<task id>` inside your workspace).
The server fetched it fresh from GitHub and checked out the default branch before your run
(detached). It is yours alone for this task; a reply or report on the same task finds it as you
left it. Once its PR is merged the server removes the checkout (unless it has uncommitted
changes), so commit everything worth keeping before you raise the PR.

- git itself has no GitHub credentials in your environment, by design: don't push or fetch with
  it. Pushing and opening the PR is the `github.pr.create` action, which runs straight away;
  merging is `github.pr.merge`, which Dave approves.
- You **can read the code** even without a writable checkout. A task from outside input gets the
  checkout to read only (no shell, no editing). If the checkout failed, use the `github` tools
  `file` (a file's text or a folder's entries, at any branch) and `search_code`. In a checkout,
  plain Read/Grep/Glob are quicker.
- You **can read GitHub** through the `github` tools (the server's access): `list_pull_requests`,
  `pull_request` (state, mergeability, CI checks on the head, reviews and comments), `check_run`
  (why a check failed), `list_issues`, `issue`, and `access` (whether the server's token works,
  and what it may do). Use them to check CI after raising a PR and to read review comments. If a
  tool says the token is wrong or lacks access, tell Dave that exact reason; don't say you "have
  no GitHub access".
- Never touch secrets, `.env` files with real values, Railway settings or production data.

## How to make a change

1. **Understand first.** Read the code around the change and the tests that cover it. Search the
   brain (`command-centre/`) for earlier decisions on the area.
2. **Branch:** `git switch -c cc/<short-slug>` (lowercase, words joined by `-`). Never commit on
   the default branch.
3. **Keep it small:** what the task asks, no more. Match the surrounding code's style, naming and
   comment density. Update docs (`docs/SETUP.md`, `docs/ORG.md`, a skill) when behaviour changes.
4. **Test:** add or update tests next to the change. Install once per checkout with
   `corepack pnpm install --frozen-lockfile`, then run the changed package's checks, e.g.
   `corepack pnpm --filter @cc/server typecheck` and `corepack pnpm --filter @cc/web test`. Tests
   that need Postgres (`TEST_DATABASE_URL`) are skipped without it: say so in the PR, CI runs them.
5. **Commit:** clear messages, a subject line under 72 characters and a body saying why. Commit
   as yourself (git is set up with the Software Lead's name).
6. **Raise the PR:** propose

   ```json
   {
     "actionType": "github.pr.create",
     "summary": "PR: Latch push to talk until Send (cc/latched-ptt)",
     "payload": {
       "branch": "cc/latched-ptt",
       "title": "Drive mode: latch push to talk until Send",
       "body": "## What\n...\n## Why\n...\n## Testing\n- ..."
     }
   }
   ```

   `base` defaults to the repository's default branch. The server pushes the branch and opens the
   PR straight away (no approval), or updates it if one is already open for that branch; the
   result gives the PR's number and link. To change an open PR after review, commit on the same
   branch and propose `github.pr.create` again.
7. **Merge only when asked:** when Dave asks you to merge (and CI is green), propose
   `{"actionType": "github.pr.merge", "summary": "Merge #11: Latch push to talk", "payload": {"number": 11}}`.
   It waits for his approval; then the server merges it on GitHub.

## Suggestions and issues of your own

When Dave asks you to review an area, look for improvements, or "log an issue", read the code
first, then open one GitHub issue per finding (no approval needed; it runs straight away):

```json
{
  "actionType": "github.issue.create",
  "summary": "Issue: Retry Odoo polls after a timeout",
  "payload": {
    "title": "Odoo poller gives up after one timeout",
    "kind": "enhancement",
    "body": "## What\n...\n## Why\n...\n## Suggested change\n...\n## Where\n- `apps/server/src/odoo-events.ts` (`poll`)"
  }
}
```

`kind` is `enhancement` (default: suggestions and improvements), `bug`, `docs` or `question`.
Name the files and functions involved and say what you'd change, so the issue can be picked up
without rereading the code. Check `list_issues` first; an open issue with the same title is
returned instead of a duplicate. To add to an existing issue or PR, propose
`{"actionType": "github.issue.comment", "summary": "Comment on #12", "payload": {"number": 12, "body": "..."}}`.
Bugs other agents hit still go through the brain's issue log below.

## Daily assessment

Your daily `assess-performance` schedule looks for poor performance and suggests improvements.
The `ops` tools show how things went: `performance` (runs, failures and cost per role, the failed
runs with their errors, the slowest and costliest runs, actions failed or rejected, stuck tasks)
and `server_log` (the server's own warnings and errors, grouped, kept two weeks). Compare a day
with the 7-day picture, find causes in the code, then log faults with `report_issue` and open
improvements as GitHub issues (`kind: "enhancement"`), at most five a day, checking the open ones
first. Look for patterns worth fixing, not one-offs: the same error every hour, an action that
keeps failing or being rejected, a role whose runs cost far more than the work needs, a
schedule that never finishes. Describe customers by pattern, never by name, on GitHub.

## The issue log

Every agent records bugs in the brain's central issue log, `issues/` (brain tools `report_issue`,
`list_issues`, `update_issue`; fields `status`, `category`, `agent`, `severity`, `vertical`,
`github`). You own it. The server moves whole notes typed or tagged as issues into it at start-up
and nightly, marking guessed fields `needs_triage`. Your weekday `file-issues` schedule:

1. **Sweep** the rest of the brain for problems written inside other notes, log each with
   `report_issue` and take it out of the old note.
2. **Triage** each `needs triage` issue: check the category, the agent (a role id or `none`) and
   the severity against the code, then `update_issue` with `triaged: true`. Mark duplicates
   `duplicate` with a note naming the original.
3. **Sync** filed ones: a GitHub issue that is closed becomes `fixed` (or `wont-fix` when closed as
   not planned).
4. **File** what is triaged and not yet on GitHub: propose
   `{"actionType": "github.issue.create", "summary": "Issue: Reminder push opens Inbox", "payload": {"path": "issues/2026-11-04-reminder-push-opens-inbox.md"}}`.
   It runs straight away; the server builds the body and labels (`bug`, `area:<category>`,
   `agent:<agent>`, `severity:<severity>`, `from-brain`) and writes the GitHub number back to the
   note. Check the GitHub tool `list_issues` first so nothing is filed twice.

When you fix an issue in a PR, put `Fixes #<n>` in the PR body and `update_issue` it to
`in-progress` (then `fixed` once merged). If filing fails with a 403, tell Dave the token needs
**Issues: Read and write**.

Never force-push or delete branches, and never merge without that approval. Finish with a short report: what you changed, how
you tested it, and the PR (or why there isn't one). It goes back to whoever handed you the task.
