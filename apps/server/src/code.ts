import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Brain, ISSUE_CATEGORIES, issueOf, isIssuePath, notePath, updateIssue } from "@cc/brain";
import type { ActionExecutor } from "./actions";

const exec = promisify(execFile);

/**
 * Coding roles (a role with a `repo`, e.g. the Software Lead): a clone of the repository in the
 * role's workspace, a git worktree per task, and the `github.pr.create` action that pushes a
 * branch and opens its pull request once Dave approves. The GitHub token never reaches the agent:
 * the server passes it to git per command (an http.extraheader), so the clone's config and the
 * agent's environment hold no credentials.
 */
export interface CodeOptions {
  /** Fine-grained token with Contents, Pull requests and Issues (read and write) on the repository. */
  token?: string;
  /** Where repositories are cloned from and pushed to (tests use a local path). Default https://github.com. */
  gitBase?: string;
  /** The GitHub REST API. Default https://api.github.com. */
  apiBase?: string;
  fetch?: typeof fetch;
}

const AUTHOR = { name: "Command Centre Software Lead", email: "software-lead@command-centre.invalid" };

function gitBase(o: CodeOptions) {
  return (o.gitBase ?? "https://github.com").replace(/\/+$/, "");
}

/** git with the token as an Authorization header for this one command (never stored). */
async function git(o: CodeOptions, cwd: string, args: string[], withAuth = false): Promise<string> {
  const auth = withAuth && o.token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${o.token}`).toString("base64")}`] : [];
  try {
    const { stdout } = await exec("git", [...auth, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    // Don't echo the header back in an error that could reach a task note.
    const message = String((err as { stderr?: string }).stderr || (err as Error).message).replace(/AUTHORIZATION: basic \S+/g, "AUTHORIZATION: ***");
    throw new Error(`git ${args[0]} failed: ${message.trim().slice(0, 500)}`);
  }
}

/** The role's clone of `repo` (owner/name), created or fetched now. */
async function ensureClone(o: CodeOptions, roleDir: string, repo: string): Promise<string> {
  const dir = join(roleDir, "repo");
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(roleDir, { recursive: true });
    await git(o, roleDir, ["clone", "--quiet", `${gitBase(o)}/${repo}.git`, "repo"], true);
    await git(o, dir, ["config", "user.name", AUTHOR.name]);
    await git(o, dir, ["config", "user.email", AUTHOR.email]);
  } else {
    await git(o, dir, ["fetch", "--quiet", "--prune", "origin"], true);
  }
  return dir;
}

/** The default branch's name (origin/HEAD), e.g. "main". */
async function defaultBranch(o: CodeOptions, clone: string): Promise<string> {
  const ref = await git(o, clone, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "origin/main");
  return ref.replace(/^origin\//, "");
}

/**
 * The task's checkout: `work/<taskId>` in the role's workspace, a worktree of the role's clone,
 * created at the default branch on the task's first run and left as the agent left it after.
 * Returns its path relative to the workspace and the default branch.
 */
export async function prepareCheckout(o: CodeOptions, roleDir: string, repo: string, taskId: string): Promise<{ path: string; base: string }> {
  // A local remote (tests) needs no token; GitHub does.
  if (!o.token && /^https?:/.test(gitBase(o))) throw new Error("GITHUB_TOKEN is not set, so the repository can't be checked out");
  const clone = await ensureClone(o, roleDir, repo);
  const base = await defaultBranch(o, clone);
  const rel = join("work", taskId);
  const abs = join(roleDir, rel);
  if (!existsSync(abs)) {
    await mkdir(join(roleDir, "work"), { recursive: true });
    await git(o, clone, ["worktree", "prune"]);
    await git(o, clone, ["worktree", "add", "--quiet", "--detach", abs, `origin/${base}`]);
  }
  return { path: rel, base };
}

/**
 * The agent's work in progress once its PR is merged: removes the task checkouts (work/<task id>)
 * that have `branch` checked out, and the local branch if it is exactly what was merged (`sha`).
 * A checkout with uncommitted changes is kept (`git worktree remove` refuses it), so nothing
 * unsaved is lost. Returns the checkouts removed, relative to the role's workspace.
 */
export async function clearMergedCheckouts(o: CodeOptions, roleDir: string, branch: string, sha?: string): Promise<string[]> {
  const clone = join(roleDir, "repo");
  if (!existsSync(join(clone, ".git")) || !BRANCH.test(branch)) return [];
  const removed: string[] = [];
  const list = await git(o, clone, ["worktree", "list", "--porcelain"]);
  for (const entry of list.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(entry)?.[1];
    if (!path || !entry.includes(`\nbranch refs/heads/${branch}`) || !path.startsWith(join(roleDir, "work"))) continue;
    try {
      await git(o, clone, ["worktree", "remove", path]);
      removed.push(path.slice(roleDir.length + 1));
    } catch (err) {
      console.log(`[code] kept ${path} after merging ${branch}: ${(err as Error).message}`);
    }
  }
  const tip = await git(o, clone, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "");
  const stillOut = (await git(o, clone, ["worktree", "list", "--porcelain"])).includes(`branch refs/heads/${branch}`);
  if (tip && sha && tip === sha && !stillOut) await git(o, clone, ["branch", "-D", branch]).catch(() => "");
  return removed;
}

/**
 * The nightly sweep for PRs merged on GitHub itself: removes every task checkout whose branch is
 * already in the default branch (merged), as clearMergedCheckouts does after github.pr.merge.
 */
export async function sweepMergedCheckouts(o: CodeOptions, roleDir: string): Promise<string[]> {
  const clone = join(roleDir, "repo");
  if (!existsSync(join(clone, ".git"))) return [];
  if (!o.token && /^https?:/.test(gitBase(o))) return [];
  await git(o, clone, ["fetch", "--quiet", "--prune", "origin"], true);
  const base = await defaultBranch(o, clone);
  const removed: string[] = [];
  const list = await git(o, clone, ["worktree", "list", "--porcelain"]);
  for (const entry of list.split(/\n\n+/)) {
    const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1];
    const path = /^worktree (.+)$/m.exec(entry)?.[1];
    if (!branch || !path?.startsWith(join(roleDir, "work"))) continue;
    const merged = await git(o, clone, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `origin/${base}`]).then(
      () => true,
      () => false,
    );
    if (merged) removed.push(...(await clearMergedCheckouts(o, roleDir, branch, await git(o, clone, ["rev-parse", `refs/heads/${branch}`]))));
  }
  return removed;
}

const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

/**
 * `github.pr.create`: pushes a branch the role committed in its checkout and opens a pull request
 * for it (or returns the one already open, after pushing the new commits). Runs without approval
 * (`auto` in the vertical's policies): a PR is for review and changes nothing until merged.
 * Never the default branch; never a force push.
 * `github.pr.merge`: merges an open pull request. Draft policy: Dave approves every merge.
 */
export function createCodeExecutors(
  o: CodeOptions & {
    /** The coding role of a vertical: its workspace folder and repository; null if it has none. */
    locate: (vertical: string) => { roleDir: string; repo: string } | null;
    /** The brain, for github.issue.create (reads the issue note, writes the GitHub number back). */
    brain?: Brain;
  },
): Record<string, ActionExecutor> {
  const parse = (payload: Record<string, unknown>) => {
    const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const body = typeof payload.body === "string" ? payload.body : "";
    const base = typeof payload.base === "string" && payload.base.trim() ? payload.base.trim() : null;
    if (!BRANCH.test(branch)) throw new Error("payload.branch must be a branch name like cc/fix-reminders");
    if (!title || title.length > 200) throw new Error("payload.title must be 1 to 200 characters");
    if (base && !BRANCH.test(base)) throw new Error("payload.base must be a branch name");
    return { branch, title, body: body.slice(0, 60_000), base };
  };
  const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: T }> => {
    const res = await (o.fetch ?? fetch)(`${(o.apiBase ?? "https://api.github.com").replace(/\/+$/, "")}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
  };

  const issueNote = async (payload: Record<string, unknown>) => {
    if (!o.brain) throw new Error("The brain isn't available to file issues");
    const raw = typeof payload.path === "string" ? payload.path.trim() : "";
    const path = raw ? notePath(raw) : "";
    if (!path || !isIssuePath(path)) throw new Error("payload.path must be an issue note in the brain's issues/ folder (from list_issues)");
    const note = await o.brain.read(path);
    if (!note) throw new Error(`There is no issue note at ${path}`);
    return { path, note, issue: issueOf(note) };
  };

  /** A GitHub issue written by the agent itself (not from a brain note): a suggestion, a bug, a question. */
  const directIssue = (payload: Record<string, unknown>) => {
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    const kind = payload.kind === undefined ? "enhancement" : payload.kind;
    if (!title || title.length > 250) throw new Error("payload.title must be 1 to 250 characters");
    if (!body) throw new Error("payload.body must describe the issue (markdown: what, why, suggested change, where in the code)");
    if (typeof kind !== "string" || !(kind in ISSUE_KINDS)) throw new Error(`payload.kind must be one of ${Object.keys(ISSUE_KINDS).join(", ")}`);
    const extra = Array.isArray(payload.labels) ? payload.labels.filter((l): l is string => typeof l === "string" && LABEL.test(l)).slice(0, 5) : [];
    return { title, body: body.slice(0, 60_000), labels: [...new Set([ISSUE_KINDS[kind as keyof typeof ISSUE_KINDS], ...extra, "from-command-centre"])] };
  };
  const repoOf = (vertical: string | null | undefined) => {
    const where = vertical ? o.locate(vertical) : null;
    if (!where) throw new Error(`${vertical ?? "This vertical"} has no coding role with a repository`);
    if (!o.token && /^https?:/.test(gitBase(o))) throw new Error("GITHUB_TOKEN is not set");
    return where;
  };

  return {
    "github.issue.create": {
      description:
        "Open a GitHub issue in your repository. Either from the brain's issue log: payload { path (issues/… from list_issues), title? } (the server builds the body and labels from the note and writes the GitHub number back to it; already filed: returns the existing issue). Or written by you, for a suggestion, an improvement, a bug or a question: payload { title, body (markdown: what and why, the suggested change, the files involved), kind? (\"enhancement\" default, \"bug\", \"docs\" or \"question\"), labels? (up to 5 more) }. An open issue with the same title is returned instead of a duplicate.",
      validate: async (payload, ctx) => {
        if (payload.path !== undefined) await issueNote(payload);
        else directIssue(payload);
        if (!o.locate(ctx.vertical)) throw new Error(`${ctx.vertical} has no coding role with a repository`);
      },
      execute: async (payload, ctx) => {
        if (payload.path === undefined) {
          const d = directIssue(payload);
          const where = repoOf(ctx.vertical);
          const open = await api<{ number: number; title: string; html_url: string; pull_request?: unknown }[]>(`/repos/${where.repo}/issues?state=open&per_page=100`);
          if (open.status === 403 || open.status === 401) throw new Error(githubIssueAccess(open.status, where.repo));
          const same = Array.isArray(open.json) ? open.json.find((i) => !i.pull_request && i.title.trim().toLowerCase() === d.title.toLowerCase()) : undefined;
          if (same) return { number: same.number, url: same.html_url, already: true };
          const created = await api<{ number?: number; html_url?: string; message?: string }>(`/repos/${where.repo}/issues`, {
            method: "POST",
            body: { title: d.title, body: `${d.body}\n\n_Opened by the Command Centre Software Lead._`, labels: d.labels },
          });
          if (created.status === 403 || created.status === 401) throw new Error(githubIssueAccess(created.status, where.repo));
          if (created.status >= 300 || !created.json.number) throw new Error(`GitHub refused the issue: ${created.json.message ?? `HTTP ${created.status}`}`);
          return { number: created.json.number, url: created.json.html_url ?? `https://github.com/${where.repo}/issues/${created.json.number}`, already: false, labels: d.labels };
        }
        const { path, note, issue } = await issueNote(payload);
        const where = repoOf(ctx.vertical);
        const url = (n: number) => `https://github.com/${where.repo}/issues/${n}`;
        if (issue.github) return { number: issue.github, url: url(issue.github), already: true };
        // The marker finds an issue filed before a failed write-back, so it is never filed twice.
        const marker = `<!-- brain:${path} -->`;
        const found = await api<{ number: number; html_url: string; body?: string | null; pull_request?: unknown }[]>(`/repos/${where.repo}/issues?state=all&labels=from-brain&per_page=100`);
        if (found.status === 403 || found.status === 401) throw new Error(githubIssueAccess(found.status, where.repo));
        const existing = Array.isArray(found.json) ? found.json.find((i) => !i.pull_request && i.body?.includes(marker)) : undefined;
        let number: number;
        let link: string;
        if (existing) {
          ({ number, html_url: link } = existing);
        } else {
          const title = (typeof payload.title === "string" && payload.title.trim()) || issue.title;
          const body = [
            note.body.replace(/^#\s+.+\n+/, "").trim(),
            "",
            "| Field | Value |",
            "| --- | --- |",
            `| Category | ${issue.category}: ${ISSUE_CATEGORIES[issue.category]} |`,
            `| Agent affected | ${issue.agent} |`,
            `| Severity | ${issue.severity} |`,
            ...(issue.vertical ? [`| Vertical | ${issue.vertical} |`] : []),
            `| Reported | ${issue.reported} by ${issue.reportedBy} |`,
            `| Brain note | \`${path}\` |`,
            "",
            "_Filed by the Command Centre Software Lead from the brain's issue log._",
            marker,
          ].join("\n");
          const labels = [issue.category === "docs" ? "documentation" : "bug", `area:${issue.category}`, `severity:${issue.severity}`, "from-brain", ...(issue.agent !== "none" ? [`agent:${issue.agent}`] : [])];
          const created = await api<{ number?: number; html_url?: string; message?: string }>(`/repos/${where.repo}/issues`, {
            method: "POST",
            body: { title: title.slice(0, 250), body: body.slice(0, 60_000), labels },
          });
          if (created.status === 403 || created.status === 401) throw new Error(githubIssueAccess(created.status, where.repo));
          if (created.status >= 300 || !created.json.number) throw new Error(`GitHub refused the issue: ${created.json.message ?? `HTTP ${created.status}`}`);
          number = created.json.number;
          link = created.json.html_url ?? url(number);
        }
        await updateIssue(o.brain!, path, { github: number, by: "software-lead" });
        return { number, url: link, already: !!existing };
      },
    },
    "github.issue.comment": {
      description:
        "Comment on an issue or pull request in your repository: a suggestion, findings from the code, a status update. payload: { number, body (markdown) }.",
      validate: (payload, ctx) => {
        parseComment(payload);
        if (!o.locate(ctx.vertical)) throw new Error(`${ctx.vertical} has no coding role with a repository`);
      },
      execute: async (payload, ctx) => {
        const c = parseComment(payload);
        const where = repoOf(ctx.vertical);
        const created = await api<{ id?: number; html_url?: string; message?: string }>(`/repos/${where.repo}/issues/${c.number}/comments`, {
          method: "POST",
          body: { body: `${c.body}\n\n_From the Command Centre Software Lead._` },
        });
        if (created.status === 404) throw new Error(`There is no issue or pull request #${c.number} in ${where.repo}`);
        if (created.status === 403 || created.status === 401) throw new Error(githubIssueAccess(created.status, where.repo));
        if (created.status >= 300 || !created.json.id) throw new Error(`GitHub refused the comment: ${created.json.message ?? `HTTP ${created.status}`}`);
        return { number: c.number, url: created.json.html_url };
      },
    },
    "github.pr.create": {
      description:
        "Push a branch you committed in your checkout and open a pull request (or update the open one). payload: { branch, title, body (markdown: what, why, testing), base? (default: the default branch) }. Never the default branch.",
      validate: (payload, ctx) => {
        parse(payload);
        if (!o.locate(ctx.vertical)) throw new Error(`${ctx.vertical} has no coding role with a repository`);
      },
      execute: async (payload, ctx) => {
        const p = parse(payload);
        const where = ctx.vertical ? o.locate(ctx.vertical) : null;
        if (!where) throw new Error(`${ctx.vertical ?? "This vertical"} has no coding role with a repository`);
        if (!o.token && /^https?:/.test(gitBase(o))) throw new Error("GITHUB_TOKEN is not set");
        const clone = join(where.roleDir, "repo");
        if (!existsSync(join(clone, ".git"))) throw new Error("There is no checkout to push from yet");
        const base = p.base ?? (await defaultBranch(o, clone));
        if (p.branch === base || ["main", "master"].includes(p.branch)) throw new Error(`Refusing to push to ${p.branch}: open a PR from a feature branch`);
        await git(o, clone, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`]).catch(() => {
          throw new Error(`There is no local branch "${p.branch}" in the checkout`);
        });
        await git(o, clone, ["fetch", "--quiet", "origin"], true);
        const ahead = Number(await git(o, clone, ["rev-list", "--count", `origin/${base}..refs/heads/${p.branch}`]));
        if (!ahead) throw new Error(`${p.branch} has no commits that aren't on ${base}`);
        // A plain push: a branch rewritten since the last push is refused, never forced.
        await git(o, clone, ["push", "--quiet", "origin", `refs/heads/${p.branch}:refs/heads/${p.branch}`], true);

        const [owner] = where.repo.split("/");
        const open = await api<{ html_url: string; number: number }[]>(`/repos/${where.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${p.branch}`)}`);
        const existing = Array.isArray(open.json) ? open.json[0] : undefined;
        if (existing) return { url: existing.html_url, number: existing.number, updated: true, commits: ahead };
        const created = await api<{ html_url?: string; number?: number; message?: string; errors?: { message?: string }[] }>(`/repos/${where.repo}/pulls`, {
          method: "POST",
          body: { title: p.title, head: p.branch, base, body: p.body },
        });
        if (created.status >= 300 || !created.json.html_url) {
          const why = created.json.errors?.map((e) => e.message).filter(Boolean).join("; ") || created.json.message || `HTTP ${created.status}`;
          throw new Error(`GitHub refused the pull request: ${why}`);
        }
        return { url: created.json.html_url, number: created.json.number, updated: false, commits: ahead };
      },
    },
    "github.pr.merge": {
      description:
        "Merge an open pull request in your repository once it is ready (CI green, review done). payload: { number, method? (\"merge\" default, \"squash\" or \"rebase\") }. Needs Dave's approval.",
      validate: (payload, ctx) => {
        parseMerge(payload);
        if (!o.locate(ctx.vertical)) throw new Error(`${ctx.vertical} has no coding role with a repository`);
      },
      execute: async (payload, ctx) => {
        const m = parseMerge(payload);
        const where = ctx.vertical ? o.locate(ctx.vertical) : null;
        if (!where) throw new Error(`${ctx.vertical ?? "This vertical"} has no coding role with a repository`);
        if (!o.token && /^https?:/.test(gitBase(o))) throw new Error("GITHUB_TOKEN is not set");
        const pr = await api<{ state?: string; merged?: boolean; html_url?: string; title?: string; head?: { sha?: string; ref?: string } }>(`/repos/${where.repo}/pulls/${m.number}`);
        if (pr.status === 404) throw new Error(`There is no pull request #${m.number} in ${where.repo}`);
        if (pr.json.merged) return { number: m.number, url: pr.json.html_url, merged: true, already: true };
        if (pr.json.state !== "open") throw new Error(`Pull request #${m.number} is ${pr.json.state ?? "not open"}`);
        // Merge the head just read: GitHub refuses if a push lands in between (sha).
        const merged = await api<{ merged?: boolean; sha?: string; message?: string }>(`/repos/${where.repo}/pulls/${m.number}/merge`, {
          method: "PUT",
          body: { merge_method: m.method, ...(pr.json.head?.sha ? { sha: pr.json.head.sha } : {}) },
        });
        if (merged.status >= 300 || !merged.json.merged) throw new Error(`GitHub didn't merge #${m.number}: ${merged.json.message ?? `HTTP ${merged.status}`}`);
        // Released: the task checkout that built it is no longer needed.
        const cleared = pr.json.head?.ref ? await clearMergedCheckouts(o, where.roleDir, pr.json.head.ref, pr.json.head.sha).catch(() => []) : [];
        return { number: m.number, url: pr.json.html_url, merged: true, sha: merged.json.sha, ...(cleared.length ? { clearedCheckouts: cleared } : {}) };
      },
    },
  };
}

/** GitHub label for each kind of issue the agent writes itself. */
const ISSUE_KINDS = { enhancement: "enhancement", bug: "bug", docs: "documentation", question: "question" } as const;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 :._/-]{0,49}$/;

function parseComment(payload: Record<string, unknown>): { number: number; body: string } {
  const number = typeof payload.number === "number" ? payload.number : Number(payload.number);
  if (!Number.isInteger(number) || number < 1) throw new Error("payload.number must be the issue or pull request number");
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!body) throw new Error("payload.body must be the comment (markdown)");
  return { number, body: body.slice(0, 60_000) };
}

function parseMerge(payload: Record<string, unknown>): { number: number; method: "merge" | "squash" | "rebase" } {
  const number = typeof payload.number === "number" ? payload.number : Number(payload.number);
  if (!Number.isInteger(number) || number < 1) throw new Error("payload.number must be the pull request number");
  const method = payload.method === undefined ? "merge" : payload.method;
  if (method !== "merge" && method !== "squash" && method !== "rebase") throw new Error('payload.method must be "merge", "squash" or "rebase"');
  return { number, method };
}

/** A 401/403 on issues, in words Dave can act on. */
function githubIssueAccess(status: number, repo: string): string {
  return status === 401
    ? "GitHub rejected GITHUB_TOKEN (401): it is wrong, expired or revoked. Make a new fine-grained token and update GITHUB_TOKEN in Railway."
    : `GITHUB_TOKEN may not create issues on ${repo} (403). Edit the fine-grained token on GitHub: Repository permissions → Issues → Read and write.`;
}
