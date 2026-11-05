import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { verticals } from "@cc/verticals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinExecutors } from "../src/actions";
import { COMMAND_CENTRE_PRIMER, HELP_INSTRUCTIONS, mcpServersFor, systemPrompt } from "../src/agent-context";
import { createHelpMcpServer, ditaToText, HelpDocs, markdownTopics } from "../src/help-docs";
import { DB_URL, makeServer, McpCallingRunner, resetDatabase } from "./helpers";

/** The repo's own docs folder: the same files the Docker image ships. */
const DOCS = resolve(__dirname, "../../../docs");

async function connect(docs: HelpDocs) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createHelpMcpServer(docs).connect(serverT);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientT);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { error: res.isError === true, text: res.content[0]!.text };
  };
}

describe("ditaToText", () => {
  it("turns a DITA topic into readable text: headings by nesting, lists, UI names, notes and named links", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">
<topic id="settings">
  <title>Settings</title>
  <shortdesc>Your account &amp; app.</shortdesc>
  <prolog><resourceid appname="command-centre" appid="settings"/></prolog>
  <body>
    <fig><title>On a phone</title><image href="x.png"><alt>The settings page</alt></image></fig>
    <p>Use <uicontrol>Check for updates</uicontrol>. See <xref href="accounts.dita">Accounts</xref> and <xref href="../work/chat.dita#chat/voice">voice</xref>.</p>
    <note type="important">Signs out every <codeph>other</codeph> device.</note>
  </body>
  <topic id="two-factor">
    <title>Two-factor</title>
    <body><ol><li>Choose <uicontrol>Set up</uicontrol>.</li><li>Scan the code.</li></ol></body>
  </topic>
</topic>`;
    const text = ditaToText(xml, "system/settings");
    expect(text).toBe(
      [
        "# Settings",
        "",
        "Your account & app.",
        "",
        "[Image: The settings page]",
        "",
        "Use **Check for updates**. See Accounts (help: system/accounts) and voice (help: work/chat#voice).",
        "",
        "Important: Signs out every `other` device.",
        "",
        "## Two-factor",
        "",
        "1. Choose **Set up**.",
        "2. Scan the code.",
      ].join("\n"),
    );
    expect(text).not.toContain("resourceid");
  });
});

describe("markdownTopics", () => {
  it("makes one topic per ## section, ignoring headings in code fences", () => {
    const md = "# Setup\n\nIntro line.\n\n## Run locally\n\nStart it.\n\n```\n## not a heading\n```\n\n## Deploy to Railway\n\nPush it.\n";
    const topics = markdownTopics("setup", md, "Setup");
    expect(topics.map((t) => t.id)).toEqual(["setup", "setup/run-locally", "setup/deploy-to-railway"]);
    expect(topics[1]!.title).toBe("Setup: Run locally");
    expect(topics[1]!.text).toContain("## not a heading");
  });
});

describe("HelpDocs (the repo's docs)", () => {
  const docs = HelpDocs.load(DOCS);

  it("loads every help page with its app route, and the setup notes", () => {
    const approvals = docs.find("work/approvals")!;
    expect(approvals.route).toBe("#/approvals");
    expect(approvals.group).toBe("Work");
    expect(approvals.text).toContain("**Approve**");
    expect(docs.find("system/settings")!.route).toBe("#/settings");
    expect(docs.topics.some((t) => t.id === "setup/deploy-to-railway")).toBe(true);
  });

  it("finds a topic by id, file name, help key or page route", () => {
    expect(docs.find("approvals")!.id).toBe("work/approvals");
    expect(docs.find("settings.two-factor")!.id).toBe("system/settings");
    expect(docs.find("#/notification-settings")!.id).toBe("system/notification-settings");
    expect(docs.find("#/brain/dms/notes.md")!.id).toBe("knowledge/brain");
    expect(docs.find("org")!.id).toBe("business/org");
    expect(docs.find("no-such-topic")).toBeNull();
  });

  it("ranks the page that answers a how-to question first", () => {
    expect(docs.search("turn on two-factor")[0]!.topic.id).toBe("system/settings");
    expect(docs.search("quiet hours")[0]!.topic.id).toBe("system/notification-settings");
    expect(docs.search("connect a mailbox")[0]!.topic.id).toBe("system/accounts");
    expect(docs.search("")).toEqual([]);
  });

  it("gives a page guide for the system prompt, with routes and topic ids", () => {
    const guide = docs.pageGuide();
    expect(guide).toContain("- Approvals (#/approvals) — ");
    expect(guide).toContain("[system/settings]");
    expect(guide).not.toContain("setup/"); // the setup notes are searched, not listed
  });

  it("is empty, not an error, without a docs folder", () => {
    const none = HelpDocs.load(join(tmpdir(), "no-docs-here"));
    expect(none.size).toBe(0);
    expect(none.pageGuide()).toBe("");
  });
});

describe("help MCP server", () => {
  it("searches, lists and reads topics", async () => {
    const call = await connect(HelpDocs.load(DOCS));
    const found = await call("search_help", { query: "two-factor" });
    expect(found.text).toContain("system/settings: Settings and your account (page #/settings)");
    const read = await call("read_help_topic", { id: "system/settings" });
    expect(read.text).toMatch(/^\[system\/settings\] Settings and your account\nApp page: #\/settings/);
    expect(read.text).toContain("Choose **Set up two-factor**.");
    expect((await call("list_help_topics", { group: "System" })).text).toContain("- system/devices: Devices: worker PCs (page #/devices)");
    const missing = await call("read_help_topic", { id: "approval" });
    expect(missing.error).toBe(true);
    expect(missing.text).toContain("Did you mean");
  });

  it("splits a long topic into parts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "help-"));
    writeFileSync(join(dir, "SETUP.md"), `# Setup\n\n## Big\n\n${"word ".repeat(5000)}\n`);
    const call = await connect(HelpDocs.load(dir));
    const first = await call("read_help_topic", { id: "setup/big" });
    expect(first.text).toContain("Part 1 of 3");
    expect((await call("read_help_topic", { id: "setup/big", part: 3 })).text).toContain("Part 3 of 3");
  });

  it("says the docs are missing rather than returning nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "help-"));
    mkdirSync(join(dir, "topics"));
    const call = await connect(HelpDocs.load(dir));
    expect((await call("search_help", { query: "approvals" })).text).toContain("aren't installed");
  });
});

describe("what a run is told about the Command Centre", () => {
  const personal = verticals.find((v) => v.id === "personal")!;

  it("every run gets the primer; the help instructions and page guide come with the docs", () => {
    const without = systemPrompt(personal, builtinExecutors);
    expect(without).toContain(COMMAND_CENTRE_PRIMER);
    expect(without).not.toContain(HELP_INSTRUCTIONS);
    const guide = HelpDocs.load(DOCS).pageGuide();
    const withDocs = systemPrompt(personal, builtinExecutors, new Date(), undefined, guide);
    expect(withDocs).toContain(HELP_INSTRUCTIONS);
    expect(withDocs).toContain("- Settings and your account (#/settings)");
  });

  it("every run gets the help server while it is mounted, whatever its role lists", () => {
    expect(Object.keys(mcpServersFor(personal, "http://x", "t", ["brain", "help"], ["brain"]))).toEqual(["actions", "help", "brain"]);
    expect(Object.keys(mcpServersFor(personal, "http://x", "t", ["brain"], ["brain"]))).toEqual(["actions", "brain"]);
  });
});

/**
 * Regression: asked how to do something in the app, the Chief of Staff had no idea how the
 * Command Centre works and no way to read its help. Every run now reaches /mcp/help with its own
 * run token, though no role lists it, and is told how to use it.
 */
describe.skipIf(!DB_URL)("help in a real run", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const runner = new McpCallingRunner([
    { server: "help", tool: "search_help", args: { query: "turn on two-factor" } },
    { server: "help", tool: "read_help_topic", args: { id: "system/settings" } },
  ]);

  beforeAll(async () => {
    await resetDatabase(DB_URL!);
    ctx = await makeServer({ runner });
    runner.app = ctx.server.app;
  });
  afterAll(async () => {
    await ctx?.server.stop();
  });

  it("lets the Chief of Staff look up how to do something in the app from a chat", async () => {
    const res = await ctx.api("/api/chat", { method: "POST", json: { text: "how do I turn on two-factor sign-in?" } });
    await ctx.queue.drain();
    const taskId = (res.body as { task: { id: string } }).task.id;
    const request = runner.requests.at(-1)!;
    expect(request.cwd?.split("/").at(-1)).toBe("chief-of-staff");
    expect(request.systemPrompt).toContain(HELP_INSTRUCTIONS);
    expect(request.systemPrompt).toContain("- Approvals (#/approvals) — ");
    expect(request.allowedTools).toContain("mcp__help");
    const detail = (await ctx.api(`/api/tasks/${taskId}`)).body as { runs: { result: string | null }[] };
    const result = detail.runs.at(-1)!.result!;
    expect(result).toContain("system/settings: Settings and your account (page #/settings)");
    expect(result).toContain("Choose **Set up two-factor**.");
  });
});
