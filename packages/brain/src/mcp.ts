import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Brain } from "./brain";
import {
  type Issue,
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUES_FOLDER,
  type IssueCategory,
  isMisplacedIssue,
  listIssues,
  NO_AGENT,
  reportIssue,
  updateIssue,
} from "./issues";
import { serializeNote } from "./note";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export interface BrainMcpOptions {
  /** Who is calling, recorded as an issue's reported_by: a role id, or "dave". Default "agent". */
  caller?: string;
  /** The vertical of the calling run, used as an issue's default vertical. */
  vertical?: string;
  /** Role ids an issue's `agent` may name (besides "none"); unchecked when absent. */
  agents?: () => string[];
}

const CATEGORY_LIST = Object.entries(ISSUE_CATEGORIES)
  .map(([k, v]) => `${k} (${v})`)
  .join("; ");

function issueLine(i: Issue): string {
  const extra = [i.vertical, i.github ? `GitHub #${i.github}` : "not on GitHub", i.needsTriage ? "needs triage" : null].filter(Boolean).join(", ");
  return `- [${i.status}] ${i.title} · ${i.category} · agent: ${i.agent} · ${i.severity} · ${i.reported} (${extra}) {path: ${i.path}}`;
}

/** MCP server exposing the brain to any agent: search, read, write, journal, list, and the central issue log. */
export function createBrainMcpServer(brain: Brain, options: BrainMcpOptions = {}): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });
  const caller = options.caller ?? "agent";
  const checkAgent = (agent: string) => {
    const known = options.agents?.();
    if (agent !== NO_AGENT && known && !known.includes(agent)) throw new Error(`agent must be a role id (${known.join(", ")}) or "none", not "${agent}"`);
  };
  const fail = (message: string) => ({ ...text(message), isError: true });

  server.registerTool(
    "search",
    {
      description: "Search the long-term knowledge brain. Returns matching note paths, titles and snippets.",
      inputSchema: {
        query: z.string().describe("Keywords to search for"),
        folder: z.string().optional().describe("Limit to a folder, e.g. a vertical id like 'dms'"),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, folder, limit }) => text(await brain.search(query, { folder, limit })),
  );

  server.registerTool(
    "read",
    {
      description: "Read one brain note by path (e.g. 'dms/customers/jane-doe.md').",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const note = await brain.read(path);
      return note ? text(serializeNote(note)) : { ...text(`No note at ${path}`), isError: true };
    },
  );

  server.registerTool(
    "write",
    {
      description:
        "Create or replace a brain note. Use frontmatter keys type, vertical and tags. Read the note first when updating so nothing is lost.",
      inputSchema: {
        path: z.string().describe("Path ending in .md, inside a vertical folder where possible"),
        body: z.string().describe("Markdown body, starting with a '# Title' heading"),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
        message: z.string().optional().describe("Commit message"),
      },
    },
    async ({ path, body, frontmatter, message }) => {
      // Issues have one home: refuse an issue note anywhere else, so none get lost in a vertical's folder.
      if (!path.replace(/^\/+/, "").startsWith(`${ISSUES_FOLDER}/`) && isMisplacedIssue({ path, frontmatter: frontmatter ?? {} })) {
        return fail(`Issues and bugs go in the central issue log, not ${path}: use report_issue (or update_issue for one already logged).`);
      }
      const note = await brain.write(path, { body, frontmatter }, message);
      return text(`Saved ${note.path}`);
    },
  );

  server.registerTool(
    "append_journal",
    {
      description: "Append a one-line entry to today's journal. Use for events, decisions and things done.",
      inputSchema: { text: z.string(), vertical: z.string().optional() },
    },
    async ({ text: entry, vertical }) => {
      const note = await brain.appendJournal(entry, { vertical });
      return text(`Appended to ${note.path}`);
    },
  );

  server.registerTool(
    "list",
    {
      description: "List note paths in the brain, optionally within one folder.",
      inputSchema: { folder: z.string().optional() },
    },
    async ({ folder }) => text(await brain.list(folder)),
  );

  // --- The central issue log (issues/): one place for every bug or fault any agent finds ---

  server.registerTool(
    "report_issue",
    {
      description:
        "Log a bug, fault or problem in the brain's central issue log (issues/). Use it for anything broken or wrong in the Command Centre, its agents or its integrations, never a note in your own folder. If an open issue with the same title exists, this adds to it instead of duplicating. Search list_issues first when unsure.",
      inputSchema: {
        title: z.string().min(3).max(150).describe("Short and specific: what is wrong, e.g. 'Reminder push opens Inbox instead of Today'"),
        description: z.string().min(1).describe("What happened, what should have happened, and how to reproduce it"),
        category: z.enum(Object.keys(ISSUE_CATEGORIES) as [IssueCategory, ...IssueCategory[]]).describe(CATEGORY_LIST),
        agent: z.string().min(1).describe('Role id of the agent affected (e.g. "pa", "dms-customer-support"), or "none"'),
        severity: z.enum(ISSUE_SEVERITIES).default("medium").describe("critical: data loss, security or everything down; high: a feature unusable; medium: wrong but workable; low: cosmetic"),
        vertical: z.string().optional().describe("The business area it affects, if any"),
        context: z.string().optional().describe("Where it was seen: a task id, order number, page"),
      },
    },
    async (a) => {
      try {
        checkAgent(a.agent);
        const { issue, duplicate } = await reportIssue(brain, { ...a, vertical: a.vertical ?? options.vertical ?? null, reportedBy: caller });
        return text(duplicate ? `Already logged; added a History line to it:\n${issueLine(issue)}` : `Logged:\n${issueLine(issue)}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_issues",
    {
      description: "Issues in the central issue log, newest first. status: open (default: open or in-progress), all, or one status.",
      inputSchema: {
        status: z.enum(["open", "all", ...ISSUE_STATUSES.filter((s) => s !== "open")] as [string, ...string[]]).default("open"),
        category: z.enum(Object.keys(ISSUE_CATEGORIES) as [IssueCategory, ...IssueCategory[]]).optional(),
        agent: z.string().optional(),
        unfiled: z.boolean().optional().describe("Only those not yet on GitHub"),
      },
    },
    async (a) => {
      const list = await listIssues(brain, a as Parameters<typeof listIssues>[1]);
      return text(list.length ? list.map(issueLine).join("\n") : "No issues match.");
    },
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Change an issue in the log by path (from list_issues): status, category, agent, severity, title, and/or add a History line (note). Set triaged: true once you have checked a needs-triage issue's fields.",
      inputSchema: {
        path: z.string().min(1),
        status: z.enum(ISSUE_STATUSES).optional(),
        category: z.enum(Object.keys(ISSUE_CATEGORIES) as [IssueCategory, ...IssueCategory[]]).optional(),
        agent: z.string().optional(),
        severity: z.enum(ISSUE_SEVERITIES).optional(),
        title: z.string().max(150).optional(),
        note: z.string().optional(),
        triaged: z.boolean().optional(),
      },
    },
    async ({ path, ...change }) => {
      try {
        if (change.agent) checkAgent(change.agent);
        return text(`Updated:\n${issueLine(await updateIssue(brain, path, { ...change, by: caller }))}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  return server;
}
