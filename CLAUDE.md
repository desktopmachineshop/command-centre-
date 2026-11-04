# Command Centre: notes for Claude

## Merging pull requests (standing permission from Dave)

This is Dave's private app; he is its only user. Dave has given standing permission for Claude to
merge its own pull requests without asking, once they are ready:

- CI is green on the PR's current head (`check` and `docker`; `windows` may be skipped);
- the PR has no merge conflict with the default branch;
- there are no unresolved review comments or requested changes.

Merge with a merge commit (not squash) into the default branch, which is `ccr-fa6f7f74-51z3o9`,
not `main`. Mark a draft PR ready for review first. Tell Dave what was merged, in one or two lines.

This permission covers PRs Claude opened for Dave's requests. It does not cover PRs from anyone
else, and it does not lift the rules against skipping tests, force-pushing shared branches or
rewriting history.

## Checks

`pnpm typecheck`, and `TEST_DATABASE_URL=postgres://… pnpm test` (see docs/SETUP.md). Run them
before pushing.
