import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { Git, type GitIdentity } from "./git";
import { type Frontmatter, type Note, noteTitle, parseNote, serializeNote } from "./note";

export interface BrainOptions {
  /** Local checkout of the brain repo. */
  dir: string;
  /** Optional remote to clone from and push to (e.g. a private GitHub repo). */
  remoteUrl?: string;
  /** Top-level folders to create on init (usually one per vertical). */
  folders?: string[];
  identity?: GitIdentity;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

/** Who made a change and why; shown in the note's history. */
export interface WriteOptions {
  message?: string;
  /** "agent" (default), "dave", "system", ... */
  author?: string;
  /** Refuse the write unless the note is still at this version (0 = must not exist yet). */
  expectedVersion?: number;
}

/**
 * What agents, the API and the MCP server need from a brain. PgBrain (Postgres)
 * is the live store; GitBrain (a git checkout) backs the stdio MCP server and
 * the git mirror.
 */
export interface Brain {
  init(): Promise<void>;
  read(path: string): Promise<Note | null>;
  write(path: string, content: { frontmatter?: Frontmatter; body: string }, options?: string | WriteOptions): Promise<Note>;
  appendJournal(text: string, options?: { vertical?: string; at?: Date }): Promise<Note>;
  list(folder?: string): Promise<string[]>;
  search(query: string, options?: { folder?: string; limit?: number }): Promise<SearchHit[]>;
}

/** Thrown when a write's expectedVersion no longer matches (someone else saved first). */
export class BrainConflictError extends Error {
  constructor(
    readonly path: string,
    readonly currentVersion: number,
  ) {
    super(`${path} changed since you opened it (now version ${currentVersion})`);
    this.name = "BrainConflictError";
  }
}

export const writeOptions = (options?: string | WriteOptions): WriteOptions =>
  typeof options === "string" ? { message: options } : (options ?? {});

/** Normalise a brain-relative path, refusing anything outside the brain or not markdown. */
export function notePath(path: string): string {
  const rel = normalize(path.replace(/^\/+/, ""));
  if (rel.startsWith("..") || rel.split(sep).includes(".git")) throw new Error(`Path outside brain: ${path}`);
  if (!rel.endsWith(".md")) throw new Error(`Brain notes must be .md files: ${path}`);
  return rel.split(sep).join("/");
}

/** The one-line journal entry appendJournal adds, and the note it lands in. */
export function journalEntry(text: string, options: { vertical?: string; at?: Date } = {}): { path: string; day: string; line: string } {
  const at = options.at ?? new Date();
  const day = at.toISOString().slice(0, 10);
  const time = at.toISOString().slice(11, 16);
  const tag = options.vertical ? ` [${options.vertical}]` : "";
  return { path: `journal/${day}.md`, day, line: `- ${time}${tag} ${text.replace(/\s*\n\s*/g, " ").trim()}` };
}

export function appendJournalLine(existing: Note | null, day: string, line: string): string {
  return existing ? `${existing.body.trimEnd()}\n${line}\n` : `# ${day}\n\n${line}\n`;
}

const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules"]);

/**
 * A brain kept in a git repo of Obsidian-compatible markdown notes with YAML frontmatter.
 * Every write is a commit; pushes go to the remote when one is configured.
 */
export class GitBrain implements Brain {
  readonly dir: string;
  private readonly git: Git;
  private readonly remoteUrl?: string;
  private readonly folders: string[];

  constructor(options: BrainOptions) {
    this.dir = options.dir;
    this.remoteUrl = options.remoteUrl;
    this.folders = options.folders ?? [];
    this.git = new Git(this.dir, options.identity ?? { name: "Command Centre", email: "command-centre@localhost" });
  }

  async init(): Promise<void> {
    if (!existsSync(join(this.dir, ".git"))) {
      if (this.remoteUrl) {
        await mkdir(dirname(this.dir), { recursive: true });
        await Git.clone(this.remoteUrl, this.dir);
      } else {
        await mkdir(this.dir, { recursive: true });
        await this.git.run("init", "--quiet", "--initial-branch=main");
      }
    } else if (this.remoteUrl) {
      await this.git.run("pull", "--quiet", "--rebase", "--autostash").catch(() => {});
    }

    const created: string[] = [];
    for (const folder of ["journal", "people", ...this.folders]) {
      const keep = join(this.dir, folder, ".gitkeep");
      if (!existsSync(keep)) {
        await mkdir(dirname(keep), { recursive: true });
        await writeFile(keep, "");
        created.push(relative(this.dir, keep));
      }
    }
    if (!existsSync(join(this.dir, "README.md"))) {
      await writeFile(join(this.dir, "README.md"), BRAIN_README);
      created.push("README.md");
    }
    if (created.length) await this.commit(created, "brain: initialise folders");
  }

  /** Resolve a brain-relative path, refusing anything outside the brain or not markdown. */
  resolve(path: string): { rel: string; abs: string } {
    const rel = notePath(path);
    return { rel, abs: join(this.dir, rel) };
  }

  async read(path: string): Promise<Note | null> {
    const { rel, abs } = this.resolve(path);
    if (!existsSync(abs)) return null;
    return parseNote(rel, await readFile(abs, "utf8"));
  }

  async write(
    path: string,
    content: { frontmatter?: Frontmatter; body: string },
    options?: string | WriteOptions,
  ): Promise<Note> {
    const { message } = writeOptions(options);
    const { rel, abs } = this.resolve(path);
    const frontmatter = { ...(content.frontmatter ?? {}), updated: new Date().toISOString() };
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, serializeNote({ frontmatter, body: content.body }));
    await this.commit([rel], message ?? `brain: update ${rel}`);
    return { path: rel, frontmatter, body: content.body };
  }

  /** Append a timestamped line to today's journal note. */
  async appendJournal(text: string, options: { vertical?: string; at?: Date } = {}): Promise<Note> {
    const { path, day, line } = journalEntry(text, options);
    const existing = await this.read(path);
    const body = appendJournalLine(existing, day, line);
    return this.write(path, { frontmatter: { ...(existing?.frontmatter ?? {}), type: "journal" }, body }, `journal: ${day}`);
  }

  async list(folder = ""): Promise<string[]> {
    const base = join(this.dir, normalize(folder.replace(/^\/+/, "")));
    if (relative(this.dir, base).startsWith("..")) throw new Error(`Path outside brain: ${folder}`);
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name));
        } else if (entry.name.endsWith(".md")) {
          out.push(relative(this.dir, join(dir, entry.name)).split(sep).join("/"));
        }
      }
    };
    await walk(base);
    return out.sort();
  }

  /**
   * Make the checkout hold exactly these notes, as one commit, and push it.
   * Used by the one-way git mirror: the remote is reset first, so edits made
   * there are replaced (they stay in the repo's history). Returns whether
   * anything changed.
   */
  async replaceAll(notes: Note[], message: string): Promise<boolean> {
    if (this.remoteUrl) {
      await this.git.run("fetch", "--quiet", "origin");
      const branch = (await this.git.run("rev-parse", "--abbrev-ref", "HEAD")).trim();
      const remote = await this.git.run("ls-remote", "--heads", "origin", branch);
      if (remote.trim()) await this.git.run("reset", "--quiet", "--hard", `origin/${branch}`);
    }
    const keep = new Set<string>();
    for (const note of notes) {
      const { rel, abs } = this.resolve(note.path);
      keep.add(rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, serializeNote(note));
    }
    for (const path of await this.list()) {
      if (!keep.has(path)) await rm(join(this.dir, path));
    }
    await this.git.run("add", "-A", "--", ".");
    const staged = await this.git.run("diff", "--cached", "--name-only");
    if (!staged.trim()) return false;
    await this.git.run("commit", "--quiet", "-m", message);
    if (this.remoteUrl) await this.git.run("push", "--quiet", "origin", "HEAD");
    return true;
  }

  /**
   * Keyword search over titles, frontmatter and bodies. Phase 0 is a plain
   * term-frequency score; a pgvector index joins it later for semantic hits.
   */
  async search(query: string, options: { folder?: string; limit?: number } = {}): Promise<SearchHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const path of await this.list(options.folder ?? "")) {
      const note = await this.read(path);
      if (!note) continue;
      const title = noteTitle(note);
      const titleText = `${title} ${path}`.toLowerCase();
      const metaText = JSON.stringify(note.frontmatter).toLowerCase();
      const bodyText = note.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (titleText.includes(term)) score += 5;
        if (metaText.includes(term)) score += 2;
        score += Math.min(countOccurrences(bodyText, term), 10);
      }
      if (score > 0) hits.push({ path, title, score, snippet: snippet(note.body, terms) });
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, options.limit ?? 10);
  }

  private async commit(paths: string[], message: string): Promise<void> {
    await this.git.run("add", "--", ...paths);
    const staged = await this.git.run("diff", "--cached", "--name-only");
    if (!staged.trim()) return;
    await this.git.run("commit", "--quiet", "-m", message);
    if (this.remoteUrl) {
      // Best effort: a failed push is retried by the next write's push.
      await this.git.run("push", "--quiet").catch(() => {});
    }
  }
}

export function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))];
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + term.length)) count++;
  return count;
}

export function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const first = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 80);
  return body.slice(start, start + 240).replace(/\s+/g, " ").trim();
}

export const BRAIN_README = `# Brain

Long-term knowledge for the command centre. Plain markdown with YAML frontmatter,
so it opens in Obsidian. Agents read and write it through the brain MCP server;
every change is a git commit.

- \`journal/\` daily log (one file per day)
- \`people/\` people and organisations
- \`<vertical>/\` one folder per business or life area

Frontmatter conventions: \`type\` (customer, product, decision, playbook, note, ...),
\`vertical\`, \`tags\`, \`updated\` (set automatically).
`;
