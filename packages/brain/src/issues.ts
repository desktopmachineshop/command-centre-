import type { Brain, WriteOptions } from "./brain";
import { type Frontmatter, type Note, noteTitle } from "./note";

/**
 * The brain's central issue log: every bug, fault or problem any agent (or Dave) finds lives in
 * `issues/`, one note per issue, with the same frontmatter fields. The Software Lead triages
 * them and files them as GitHub issues (github.issue.create), which writes the GitHub number
 * back here. `auditIssues` moves issue notes written anywhere else into `issues/`.
 */

export const ISSUES_FOLDER = "issues";

/** What part of the system is at fault. */
export const ISSUE_CATEGORIES = {
  ui: "The app's pages, layout, buttons, notifications on screen (apps/web, desktop app)",
  backend: "Server logic, the database, the queue, scheduling, the API (apps/server, packages/*)",
  integration: "An outside service: Google, Odoo, email, social platforms, Sendcloud, GitHub, Railway",
  agent: "An agent did the wrong thing: its skill, prompt, role, routing or permissions",
  data: "Wrong or missing data: brain notes, products, prices, records",
  infrastructure: "Hosting, deploys, the desktop worker, certificates, DNS, performance",
  docs: "Documentation or setup instructions",
  other: "Anything else",
} as const;
export type IssueCategory = keyof typeof ISSUE_CATEGORIES;

export const ISSUE_STATUSES = ["open", "in-progress", "fixed", "wont-fix", "duplicate"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const OPEN_ISSUE_STATUSES: readonly IssueStatus[] = ["open", "in-progress"];

export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** `agent` when no agent is affected (a UI glitch, an outage). */
export const NO_AGENT = "none";

export interface Issue {
  path: string;
  title: string;
  status: IssueStatus;
  category: IssueCategory;
  /** The affected agent's role id, or "none". */
  agent: string;
  severity: IssueSeverity;
  vertical: string | null;
  reported: string;
  reportedBy: string;
  /** GitHub issue number once the Software Lead has filed it. */
  github: number | null;
  /** Fields still to fill in: true for notes moved in by the audit with guessed fields. */
  needsTriage: boolean;
  body: string;
}

export interface NewIssue {
  title: string;
  /** What happened, what was expected, how to reproduce; markdown. */
  description: string;
  category: IssueCategory;
  agent: string;
  severity?: IssueSeverity;
  vertical?: string | null;
  reportedBy: string;
  /** Where it was seen: a task id, an order, a page. */
  context?: string;
}

export interface IssueChange {
  status?: IssueStatus;
  category?: IssueCategory;
  agent?: string;
  severity?: IssueSeverity;
  title?: string;
  github?: number | null;
  /** A line added to the note's History (e.g. "Seen again on order 1042"). */
  note?: string;
  /** Who made the change, for the History line. */
  by?: string;
  /** Marks the guessed fields as checked (clears needs_triage). */
  triaged?: boolean;
}

/** Deletion is optional on Brain (PgBrain has it); the audit needs it to move notes. */
export type BrainWithDelete = Brain & { delete(path: string, options?: WriteOptions): Promise<boolean> };

const today = (now: Date) => now.toISOString().slice(0, 10);

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "issue"
  );
}

export function isIssuePath(path: string): boolean {
  return path.startsWith(`${ISSUES_FOLDER}/`) && path !== `${ISSUES_FOLDER}/README.md`;
}

const ISSUE_TYPES = new Set(["issue", "bug", "defect", "fault", "known-issue"]);
const ISSUE_TAGS = new Set(["issue", "bug", "bugs", "defect", "known-issue", "known-issues"]);
const ISSUE_DIRS = new Set(["issues", "bugs", "known-issues", "defects"]);

/**
 * Whether a note outside `issues/` is an issue record that belongs there: its type is issue
 * or bug, it is tagged bug or issue, or it sits in an issues/bugs folder of its own
 * (e.g. `command-centre/bugs/x.md`). Notes that only mention a bug in passing are left alone.
 */
export function isMisplacedIssue(note: Pick<Note, "path" | "frontmatter">): boolean {
  if (isIssuePath(note.path) || note.path === `${ISSUES_FOLDER}/README.md`) return false;
  const fm = note.frontmatter;
  if (typeof fm.type === "string" && ISSUE_TYPES.has(fm.type.toLowerCase())) return true;
  const tags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(/[\s,]+/) : [];
  if (tags.some((t) => typeof t === "string" && ISSUE_TAGS.has(t.toLowerCase()))) return true;
  return note.path.split("/").slice(0, -1).some((dir) => ISSUE_DIRS.has(dir.toLowerCase()));
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  const v = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
};

const STATUS_ALIASES: Record<string, IssueStatus> = { closed: "fixed", resolved: "fixed", done: "fixed", wontfix: "wont-fix", "in progress": "in-progress", new: "open", todo: "open" };
const CATEGORY_ALIASES: Record<string, IssueCategory> = { frontend: "ui", web: "ui", pwa: "ui", server: "backend", api: "backend", db: "backend", database: "backend", infra: "infrastructure", deploy: "infrastructure", integrations: "integration", skill: "agent", prompt: "agent", documentation: "docs" };

/** An issue note's fields, filling gaps with defaults (and flagging the note for triage if any were missing). */
export function issueOf(note: Note): Issue {
  const fm = note.frontmatter;
  const raw = (k: string) => (typeof fm[k] === "string" ? (fm[k] as string).trim().toLowerCase() : "");
  const status = STATUS_ALIASES[raw("status")] ?? pick(fm.status, ISSUE_STATUSES, "open");
  const category = CATEGORY_ALIASES[raw("category")] ?? pick(fm.category, Object.keys(ISSUE_CATEGORIES) as IssueCategory[], "other");
  const agent = typeof fm.agent === "string" && fm.agent.trim() ? fm.agent.trim() : NO_AGENT;
  const github = typeof fm.github === "number" ? fm.github : typeof fm.github === "string" && /^\d+$/.test(fm.github) ? Number(fm.github) : null;
  return {
    path: note.path,
    title: noteTitle(note),
    status,
    category,
    agent,
    severity: pick(fm.severity, ISSUE_SEVERITIES, "medium"),
    vertical: typeof fm.vertical === "string" && fm.vertical ? fm.vertical : null,
    reported: typeof fm.reported === "string" ? fm.reported : String(fm.reported ?? fm.created ?? fm.updated ?? "").slice(0, 10),
    reportedBy: typeof fm.reported_by === "string" ? fm.reported_by : "unknown",
    github,
    needsTriage: fm.needs_triage === true || !fm.category || !fm.agent,
    body: note.body,
  };
}

/** The frontmatter every issue note carries, in a stable order. */
export function issueFrontmatter(i: Omit<Issue, "path" | "title" | "body">, extra: Frontmatter = {}): Frontmatter {
  return {
    ...extra,
    type: "issue",
    status: i.status,
    category: i.category,
    agent: i.agent,
    severity: i.severity,
    ...(i.vertical ? { vertical: i.vertical } : {}),
    reported: i.reported,
    reported_by: i.reportedBy,
    github: i.github,
    ...(i.needsTriage ? { needs_triage: true } : {}),
  };
}

/** A path in `issues/` that no note uses yet. */
async function freePath(brain: Brain, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const path = `${ISSUES_FOLDER}/${base}${n === 1 ? "" : `-${n}`}.md`;
    if (!(await brain.read(path))) return path;
  }
}

/** Every issue note, newest first. */
export async function listIssues(
  brain: Brain,
  filter: { status?: "open" | "all" | IssueStatus; category?: IssueCategory; agent?: string; unfiled?: boolean } = {},
): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const path of await brain.list(ISSUES_FOLDER)) {
    if (!isIssuePath(path)) continue;
    const note = await brain.read(path);
    if (!note) continue;
    const i = issueOf(note);
    const status = filter.status ?? "open";
    if (status === "open" ? !OPEN_ISSUE_STATUSES.includes(i.status) : status !== "all" && i.status !== status) continue;
    if (filter.category && i.category !== filter.category) continue;
    if (filter.agent && i.agent !== filter.agent) continue;
    if (filter.unfiled && i.github !== null) continue;
    out.push(i);
  }
  return out.sort((a, b) => b.reported.localeCompare(a.reported) || a.path.localeCompare(b.path));
}

/**
 * Records an issue in `issues/`. If an open issue with the same title exists, it is the same
 * problem seen again: a History line is added to that note instead of a duplicate.
 */
export async function reportIssue(brain: Brain, input: NewIssue, now = new Date()): Promise<{ issue: Issue; duplicate: boolean }> {
  const title = input.title.trim().replace(/^#+\s*/, "");
  if (!title) throw new Error("an issue needs a title");
  const same = (await listIssues(brain)).find((i) => slugify(i.title) === slugify(title));
  const report = `${input.context ? `${input.context.replace(/\s+/g, " ").trim()}: ` : ""}${input.description.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  if (same) {
    return { issue: await updateIssue(brain, same.path, { note: `Seen again: ${report}`, by: input.reportedBy }, now), duplicate: true };
  }
  const line = `- ${today(now)}: reported (${input.reportedBy}): ${report}`;
  const path = await freePath(brain, `${today(now)}-${slugify(title)}`);
  const fields = {
    status: "open" as const,
    category: input.category,
    agent: input.agent || NO_AGENT,
    severity: input.severity ?? "medium",
    vertical: input.vertical ?? null,
    reported: today(now),
    reportedBy: input.reportedBy,
    github: null,
    needsTriage: false,
  };
  const body = `# ${title}\n\n${input.description.trim()}\n${input.context ? `\n**Seen in:** ${input.context.trim()}\n` : ""}\n## History\n${line}\n`;
  const note = await brain.write(path, { frontmatter: issueFrontmatter(fields), body }, { message: `issues: report ${title}`, author: input.reportedBy });
  return { issue: issueOf(note), duplicate: false };
}

/** Changes an issue's fields and/or adds a History line. Clears needs_triage once category and agent are set. */
export async function updateIssue(brain: Brain, path: string, change: IssueChange, now = new Date()): Promise<Issue> {
  const note = await brain.read(path);
  if (!note || !isIssuePath(note.path)) throw new Error(`No issue at ${path}. list_issues gives the paths.`);
  const current = issueOf(note);
  const next = {
    ...current,
    ...(change.status ? { status: change.status } : {}),
    ...(change.category ? { category: change.category } : {}),
    ...(change.agent ? { agent: change.agent } : {}),
    ...(change.severity ? { severity: change.severity } : {}),
    ...(change.github !== undefined ? { github: change.github } : {}),
  };
  const fm = note.frontmatter;
  // A guessed issue is triaged once its category and agent are both set on purpose (or `triaged` says so).
  next.needsTriage = current.needsTriage && !(change.triaged || (change.category && change.agent));
  let body = note.body;
  if (change.title?.trim()) body = /^#\s+.+$/m.test(body) ? body.replace(/^#\s+.+$/m, `# ${change.title.trim()}`) : `# ${change.title.trim()}\n\n${body}`;
  const what = [
    change.status && change.status !== current.status ? `status ${current.status} → ${change.status}` : null,
    change.category && change.category !== current.category ? `category ${change.category}` : null,
    change.agent && change.agent !== current.agent ? `agent ${change.agent}` : null,
    change.severity && change.severity !== current.severity ? `severity ${change.severity}` : null,
    change.github !== undefined && change.github !== current.github ? (change.github ? `filed as GitHub #${change.github}` : "GitHub link removed") : null,
  ].filter(Boolean);
  const text = [what.join(", "), change.note?.replace(/\s+/g, " ").trim()].filter(Boolean).join(". ");
  if (text) {
    const line = `- ${today(now)}: ${text}${change.by ? ` (${change.by})` : ""}`;
    body = /^## History\s*$/m.test(body) ? `${body.trimEnd()}\n${line}\n` : `${body.trimEnd()}\n\n## History\n${line}\n`;
  }
  const { type: _t, status: _s, category: _c, agent: _a, severity: _v, vertical: _vv, reported: _r, reported_by: _rb, github: _g, needs_triage: _n, updated: _u, ...extra } = fm;
  const saved = await brain.write(path, { frontmatter: issueFrontmatter(next, extra), body }, { message: `issues: update ${current.title}`, author: change.by ?? "agent" });
  return issueOf(saved);
}

/**
 * Moves every issue note found outside `issues/` into it (see isMisplacedIssue), keeping its
 * body and history line, filling the standard fields from what the note had (or guessing, and
 * marking it needs_triage for the Software Lead), and recording where it came from. The old
 * note is deleted; its versions stay in the brain's history. Safe to run any number of times.
 */
export async function auditIssues(
  brain: BrainWithDelete,
  options: { verticals?: string[]; now?: Date } = {},
): Promise<{ moved: { from: string; to: string }[] }> {
  const now = options.now ?? new Date();
  const verticals = new Set(options.verticals ?? []);
  const moved: { from: string; to: string }[] = [];
  for (const path of await brain.list()) {
    if (path.startsWith(`${ISSUES_FOLDER}/`)) continue;
    const note = await brain.read(path);
    if (!note || !isMisplacedIssue(note)) continue;
    const fm = note.frontmatter;
    const i = issueOf(note);
    const top = path.split("/")[0]!;
    const vertical = i.vertical ?? (verticals.has(top) ? top : null);
    const name = path.split("/").pop()!.replace(/\.md$/, "");
    const base = /^\d{4}-\d{2}-\d{2}-/.test(name) ? slugify(name) : `${(i.reported || today(now)).slice(0, 10)}-${slugify(name)}`;
    const to = await freePath(brain, base);
    const { type: _t, status: _s, category: _c, agent: _a, severity: _v, vertical: _vv, reported: _r, reported_by: _rb, github: _g, needs_triage: _n, updated: _u, ...extra } = fm;
    const fields = {
      ...i,
      vertical,
      reported: /^\d{4}-\d{2}-\d{2}$/.test(i.reported) ? i.reported : today(now),
      reportedBy: i.reportedBy === "unknown" && typeof fm.author === "string" ? fm.author : i.reportedBy,
      needsTriage: i.needsTriage || !fm.category || !fm.agent,
    };
    const body = /^#\s+/m.test(note.body) ? note.body : `# ${noteTitle(note)}\n\n${note.body}`;
    const history = `- ${today(now)}: moved here from ${path} by the issues audit`;
    const withHistory = /^## History\s*$/m.test(body) ? `${body.trimEnd()}\n${history}\n` : `${body.trimEnd()}\n\n## History\n${history}\n`;
    await brain.write(to, { frontmatter: issueFrontmatter(fields, { ...extra, moved_from: path }), body: withHistory }, { message: `issues: move ${path} to ${to}`, author: "system" });
    await brain.delete(path, { message: `issues: moved to ${to}`, author: "system" });
    moved.push({ from: path, to });
  }
  return { moved };
}

/** The `issues/README.md` note: what the folder is and the fields every issue carries. */
export const ISSUES_README = `# Issues

Every bug, fault or problem found by any agent or by Dave, one note per issue. Agents record
them with the brain tool \`report_issue\` (never in their own folders); the Software Lead triages
them and files them on GitHub, and the GitHub number is written back here.

| Field | Values |
| --- | --- |
| \`status\` | ${ISSUE_STATUSES.join(", ")} |
| \`category\` | ${Object.keys(ISSUE_CATEGORIES).join(", ")} |
| \`agent\` | the affected agent's role id (e.g. \`pa\`, \`software-lead\`), or \`none\` |
| \`severity\` | ${ISSUE_SEVERITIES.join(", ")} |
| \`vertical\` | the business area, if any |
| \`reported\`, \`reported_by\` | when and by whom |
| \`github\` | the GitHub issue number, once filed |
| \`needs_triage\` | true while category, agent or severity are guesses |

Issue notes written anywhere else in the brain are moved here automatically (daily, and at
start-up), with \`moved_from\` saying where they were.
`;
