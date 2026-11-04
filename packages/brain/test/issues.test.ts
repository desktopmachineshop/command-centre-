import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { auditIssues, type BrainWithDelete, createBrainMcpServer, isMisplacedIssue, listIssues, type Note, reportIssue, slugify, updateIssue } from "../src";

/** A brain in memory, with delete (as PgBrain has). */
function memoryBrain(seed: Record<string, Pick<Note, "frontmatter" | "body">> = {}) {
  const notes = new Map<string, Note>(Object.entries(seed).map(([path, n]) => [path, { path, ...n }]));
  const deleted: string[] = [];
  const brain: BrainWithDelete = {
    init: async () => {},
    read: async (path) => notes.get(path.replace(/^\/+/, "")) ?? null,
    write: async (path, content) => {
      const note = { path, frontmatter: { ...(content.frontmatter ?? {}), updated: "2026-11-04T12:00:00.000Z" }, body: content.body };
      notes.set(path, note);
      return note;
    },
    appendJournal: async () => ({ path: "journal/x.md", frontmatter: {}, body: "" }),
    list: async (folder = "") => [...notes.keys()].filter((p) => !folder || p.startsWith(`${folder.replace(/\/$/, "")}/`)).sort(),
    search: async () => [],
    delete: async (path) => {
      deleted.push(path);
      return notes.delete(path);
    },
  };
  return { brain, notes, deleted };
}

const NOW = new Date("2026-11-04T12:00:00Z");

describe("the central issue log", () => {
  it("reports an issue with the standard fields, and adds to it when seen again", async () => {
    const { brain, notes } = memoryBrain();
    const { issue } = await reportIssue(
      brain,
      { title: "Reminder push opens Inbox", description: "Tapping it opened Inbox, not Today.", category: "ui", agent: "none", severity: "high", reportedBy: "pa", context: "task 1234" },
      NOW,
    );
    expect(issue).toMatchObject({ path: "issues/2026-11-04-reminder-push-opens-inbox.md", status: "open", category: "ui", agent: "none", severity: "high", github: null, needsTriage: false, reportedBy: "pa" });
    expect(notes.get(issue.path)!.frontmatter).toMatchObject({ type: "issue", status: "open", category: "ui", agent: "none", severity: "high", reported: "2026-11-04", reported_by: "pa", github: null });
    expect(notes.get(issue.path)!.body).toContain("**Seen in:** task 1234");

    const again = await reportIssue(brain, { title: "reminder push opens inbox", description: "Again on Android.", category: "ui", agent: "none", reportedBy: "chief-of-staff" }, NOW);
    expect(again.duplicate).toBe(true);
    expect([...notes.keys()]).toEqual([issue.path]);
    expect(notes.get(issue.path)!.body).toContain("## History\n- 2026-11-04: reported (pa): task 1234: Tapping it opened Inbox, not Today.\n- 2026-11-04: Seen again: Again on Android. (chief-of-staff)\n");
  });

  it("updates fields, records them in History, and filters the list", async () => {
    const { brain } = memoryBrain();
    const a = (await reportIssue(brain, { title: "Odoo stock sync skips variants", description: "x", category: "integration", agent: "dms-ops", reportedBy: "dms-ops" }, NOW)).issue;
    await reportIssue(brain, { title: "Typo on Org page", description: "y", category: "ui", agent: "none", severity: "low", reportedBy: "dave" }, NOW);
    const b = await updateIssue(brain, a.path, { status: "in-progress", github: 12, note: "PR raised", by: "software-lead" }, NOW);
    expect(b).toMatchObject({ status: "in-progress", github: 12 });
    expect(b.body).toContain("- 2026-11-04: status open → in-progress, filed as GitHub #12. PR raised (software-lead)");
    expect((await listIssues(brain, { category: "ui" })).map((i) => i.title)).toEqual(["Typo on Org page"]);
    expect((await listIssues(brain, { unfiled: true })).map((i) => i.title)).toEqual(["Typo on Org page"]);
    expect((await listIssues(brain, { agent: "dms-ops" })).map((i) => i.github)).toEqual([12]);
    await updateIssue(brain, a.path, { status: "fixed" }, NOW);
    expect((await listIssues(brain)).map((i) => i.title)).toEqual(["Typo on Org page"]);
    expect(await listIssues(brain, { status: "fixed" })).toHaveLength(1);
    await expect(updateIssue(brain, "dms/x.md", { status: "fixed" })).rejects.toThrow(/No issue at/);
  });

  it("knows an issue note from a note that only mentions a bug", () => {
    expect(isMisplacedIssue({ path: "dms/x.md", frontmatter: { type: "Bug" } })).toBe(true);
    expect(isMisplacedIssue({ path: "dms/x.md", frontmatter: { tags: ["wholesale", "bug"] } })).toBe(true);
    expect(isMisplacedIssue({ path: "command-centre/known-issues/push.md", frontmatter: {} })).toBe(true);
    expect(isMisplacedIssue({ path: "dms/playbooks/returns.md", frontmatter: { type: "playbook", tags: ["returns"] } })).toBe(false);
    expect(isMisplacedIssue({ path: "issues/2026-11-04-x.md", frontmatter: { type: "issue" } })).toBe(false);
    expect(slugify("Ünïcode: push → Today!!")).toBe("unicode-push-today");
  });

  it("moves issue notes from anywhere into issues/, guessing missing fields for triage", async () => {
    const { brain, notes, deleted } = memoryBrain({
      "command-centre/bugs/voice-cuts-out.md": { frontmatter: { type: "bug", status: "Resolved", reported: "2026-10-30" }, body: "# Voice cuts out in Drive mode\n\nAfter 30s." },
      "dms/2026-11-01-odoo-sync.md": { frontmatter: { type: "note", tags: ["issue"], category: "integrations", agent: "dms-ops", severity: "high" }, body: "Odoo sync dropped 3 orders." },
      "dms/playbooks/returns.md": { frontmatter: { type: "playbook" }, body: "# Returns\n\nA known bug in the label printer: reprint." },
      "issues/2026-11-02-already-here.md": { frontmatter: { type: "issue", category: "ui", agent: "none" }, body: "# Already here" },
    });
    const { moved } = await auditIssues(brain, { verticals: ["dms", "command-centre"], now: NOW });
    expect(moved).toEqual([
      { from: "command-centre/bugs/voice-cuts-out.md", to: "issues/2026-10-30-voice-cuts-out.md" },
      { from: "dms/2026-11-01-odoo-sync.md", to: "issues/2026-11-01-odoo-sync.md" },
    ]);
    expect(deleted).toEqual(moved.map((m) => m.from));
    expect(notes.has("dms/playbooks/returns.md")).toBe(true);

    const voice = notes.get("issues/2026-10-30-voice-cuts-out.md")!;
    expect(voice.frontmatter).toMatchObject({ type: "issue", status: "fixed", category: "other", agent: "none", vertical: "command-centre", reported: "2026-10-30", needs_triage: true, moved_from: "command-centre/bugs/voice-cuts-out.md" });
    expect(voice.body).toContain("- 2026-11-04: moved here from command-centre/bugs/voice-cuts-out.md by the issues audit");
    const odoo = notes.get("issues/2026-11-01-odoo-sync.md")!;
    expect(odoo.frontmatter).toMatchObject({ category: "integration", agent: "dms-ops", severity: "high", vertical: "dms", tags: ["issue"] });
    expect(odoo.frontmatter.needs_triage).toBeUndefined();
    expect(odoo.body.startsWith("# 2026-11-01-odoo-sync\n\nOdoo sync dropped 3 orders.")).toBe(true);

    // Triage clears the flag; a second audit moves nothing.
    expect((await updateIssue(brain, voice.path, { category: "integration", agent: "pa" }, NOW)).needsTriage).toBe(false);
    expect((await auditIssues(brain, { now: NOW })).moved).toEqual([]);
  });
});

describe("brain MCP issue tools", () => {
  async function connect(brain: BrainWithDelete) {
    const server = createBrainMcpServer(brain, { caller: "dms-ops", vertical: "dms", agents: () => ["pa", "dms-ops", "software-lead"] });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const mcp = new Client({ name: "t", version: "0" });
    await mcp.connect(c);
    return async (name: string, args: Record<string, unknown>) => {
      const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, isError: !!r.isError };
    };
  }

  it("reports, lists and updates issues as the calling role, and refuses issues written elsewhere", async () => {
    const { brain, notes } = memoryBrain();
    const call = await connect(brain);
    const r = await call("report_issue", { title: "Stock sync skips variants", description: "Variants of SKU 100 not synced.", category: "integration", agent: "dms-ops" });
    expect(r.text).toMatch(/^Logged:\n- \[open\] Stock sync skips variants · integration · agent: dms-ops · medium · \d{4}-\d{2}-\d{2} \(dms, not on GitHub\) \{path: issues\/.+\}$/);
    const path = /\{path: (.+)\}/.exec(r.text)![1]!;
    expect(notes.get(path)!.frontmatter).toMatchObject({ reported_by: "dms-ops", vertical: "dms" });
    expect((await call("report_issue", { title: "Xyz broken", description: "x", category: "ui", agent: "nobody" })).isError).toBe(true);
    expect((await call("list_issues", { category: "integration" })).text).toContain("Stock sync skips variants");
    expect((await call("update_issue", { path, status: "in-progress", agent: "software-lead" })).text).toContain("[in-progress]");

    const w = await call("write", { path: "dms/bugs/printer.md", body: "# Printer jams" });
    expect(w).toMatchObject({ isError: true });
    expect(w.text).toContain("use report_issue");
    expect((await call("write", { path: "dms/notes/x.md", body: "# x", frontmatter: { type: "bug" } })).isError).toBe(true);
    expect((await call("write", { path: "dms/notes/printer.md", body: "# Printer settings" })).isError).toBe(false);
  });
});
