import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Brain, createBrainMcpServer, parseNote, serializeNote } from "../src";

let brain: Brain;
beforeEach(async () => {
  brain = new Brain({ dir: join(mkdtempSync(join(tmpdir(), "brain-")), "brain"), folders: ["dms", "personal"] });
  await brain.init();
});

const gitLog = () => execFileSync("git", ["log", "--format=%s"], { cwd: brain.dir }).toString().trim().split("\n");

describe("notes", () => {
  it("round-trips frontmatter and body", () => {
    const raw = serializeNote({ frontmatter: { type: "customer", tags: ["vip"] }, body: "# Jane\n\nLikes spindles." });
    const note = parseNote("dms/jane.md", raw);
    expect(note.frontmatter).toEqual({ type: "customer", tags: ["vip"] });
    expect(note.body).toBe("# Jane\n\nLikes spindles.\n");
  });

  it("treats files without frontmatter as body", () => {
    expect(parseNote("a.md", "# A").frontmatter).toEqual({});
  });
});

describe("Brain", () => {
  it("initialises a git repo with vertical folders", async () => {
    expect(await brain.list()).toEqual(["README.md"]);
    expect(gitLog()).toEqual(["brain: initialise folders"]);
  });

  it("writes, reads and commits notes", async () => {
    await brain.write("dms/products/er11-collet.md", { frontmatter: { type: "product" }, body: "# ER11 collet set\n\nFits 300W spindles." });
    const note = await brain.read("dms/products/er11-collet.md");
    expect(note?.frontmatter.type).toBe("product");
    expect(note?.frontmatter.updated).toBeTypeOf("string");
    expect(gitLog()[0]).toBe("brain: update dms/products/er11-collet.md");
  });

  it("refuses paths outside the brain and non-markdown files", async () => {
    await expect(brain.write("../evil.md", { body: "x" })).rejects.toThrow(/outside/);
    await expect(brain.write(".git/config.md", { body: "x" })).rejects.toThrow(/outside/);
    await expect(brain.write("dms/x.sh", { body: "x" })).rejects.toThrow(/\.md/);
  });

  it("appends to the daily journal", async () => {
    const at = new Date("2026-10-23T09:15:00Z");
    await brain.appendJournal("Shipped order 1042", { vertical: "dms", at });
    await brain.appendJournal("Booked dentist", { at });
    const note = await brain.read("journal/2026-10-23.md");
    expect(note?.body).toBe("# 2026-10-23\n\n- 09:15 [dms] Shipped order 1042\n- 09:15 Booked dentist\n");
  });

  it("ranks search hits by title then body matches", async () => {
    await brain.write("dms/spindle-faq.md", { body: "# Spindle FAQ\n\nRunout questions." });
    await brain.write("personal/shopping.md", { body: "# Shopping\n\nBuy a spindle belt." });
    const hits = await brain.search("spindle");
    expect(hits.map((h) => h.path)).toEqual(["dms/spindle-faq.md", "personal/shopping.md"]);
    expect(await brain.search("spindle", { folder: "personal" })).toHaveLength(1);
  });
});

describe("brain MCP server", () => {
  it("exposes the brain tools", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createBrainMcpServer(brain).connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["append_journal", "list", "read", "search", "write"]);

    await client.callTool({ name: "write", arguments: { path: "dms/note.md", body: "# Note\n\nhello" } });
    const read = await client.callTool({ name: "read", arguments: { path: "dms/note.md" } });
    expect(JSON.stringify(read.content)).toContain("hello");

    const missing = await client.callTool({ name: "read", arguments: { path: "dms/nope.md" } });
    expect(missing.isError).toBe(true);
  });
});
