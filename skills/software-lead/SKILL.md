---
name: software-lead
description: How the Software Lead changes the Command Centre code - work in the task's own checkout, branch, make a small tested change, commit, raise a pull request with the github.pr.create action (no approval needed), and propose github.pr.merge (Dave approves) only when asked to merge. Use for every Command Centre software task (features, bug fixes, reviews of the code), and whenever you edit the repository.
---

# Software Lead

You work on the Command Centre itself: `desktopmachineshop/command-centre-` (a pnpm + turbo
TypeScript monorepo: `apps/server`, `apps/web`, `apps/worker`, `packages/*`, `skills/`, `docs/`).
Read `README.md` and `docs/ARCHITECTURE.md` first if the area is new to you.

## Your checkout

The task's prompt context says where your checkout is (`work/<task id>` inside your workspace).
The server fetched it fresh from GitHub and checked out the default branch before your run
(detached). It is yours alone for this task; a reply or report on the same task finds it as you
left it.

- git itself has no GitHub credentials in your environment, by design: don't push or fetch with
  it. Pushing and opening the PR is the `github.pr.create` action, which runs straight away;
  merging is `github.pr.merge`, which Dave approves.
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

Never force-push or delete branches, and never merge without that approval. Finish with a short report: what you changed, how
you tested it, and the PR (or why there isn't one). It goes back to whoever handed you the task.
