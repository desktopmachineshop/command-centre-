---
name: software-lead
description: How the Software Lead changes the Command Centre code - work in the task's own checkout, branch, make a small tested change, commit, and raise a pull request with the github.pr.create action for Dave to approve. Use for every Command Centre software task (features, bug fixes, reviews of the code), and whenever you edit the repository.
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

- You can't push or reach GitHub with git yourself: there are no credentials in your
  environment, by design. Pushing and opening the PR is the `github.pr.create` action, which Dave
  approves.
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

   `base` defaults to the repository's default branch. When Dave approves, the server pushes the
   branch and opens the PR, or updates it if one is already open for that branch. To change an
   open PR after review, commit on the same branch and propose `github.pr.create` again.

Never merge, force-push or delete branches. Finish with a short report: what you changed, how
you tested it, and the PR (or why there isn't one). It goes back to whoever handed you the task.
