import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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
  /** Fine-grained token with Contents and Pull requests (read and write) on the repository. */
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

  return {
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
        const pr = await api<{ state?: string; merged?: boolean; html_url?: string; title?: string; head?: { sha?: string } }>(`/repos/${where.repo}/pulls/${m.number}`);
        if (pr.status === 404) throw new Error(`There is no pull request #${m.number} in ${where.repo}`);
        if (pr.json.merged) return { number: m.number, url: pr.json.html_url, merged: true, already: true };
        if (pr.json.state !== "open") throw new Error(`Pull request #${m.number} is ${pr.json.state ?? "not open"}`);
        // Merge the head just read: GitHub refuses if a push lands in between (sha).
        const merged = await api<{ merged?: boolean; sha?: string; message?: string }>(`/repos/${where.repo}/pulls/${m.number}/merge`, {
          method: "PUT",
          body: { merge_method: m.method, ...(pr.json.head?.sha ? { sha: pr.json.head.sha } : {}) },
        });
        if (merged.status >= 300 || !merged.json.merged) throw new Error(`GitHub didn't merge #${m.number}: ${merged.json.message ?? `HTTP ${merged.status}`}`);
        return { number: m.number, url: pr.json.html_url, merged: true, sha: merged.json.sha };
      },
    },
  };
}

function parseMerge(payload: Record<string, unknown>): { number: number; method: "merge" | "squash" | "rebase" } {
  const number = typeof payload.number === "number" ? payload.number : Number(payload.number);
  if (!Number.isInteger(number) || number < 1) throw new Error("payload.number must be the pull request number");
  const method = payload.method === undefined ? "merge" : payload.method;
  if (method !== "merge" && method !== "squash" && method !== "rebase") throw new Error('payload.method must be "merge", "squash" or "rebase"');
  return { number, method };
}
