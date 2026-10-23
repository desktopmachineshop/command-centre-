import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Brain } from "./brain";
import { serializeNote } from "./note";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** MCP server exposing the brain to any agent: search, read, write, journal, list. */
export function createBrainMcpServer(brain: Brain): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });

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

  return server;
}
