#!/usr/bin/env node
// Brain MCP server over stdio. Configure with DATABASE_URL (the live Postgres brain),
// or BRAIN_DIR for a local git checkout.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { type Brain, GitBrain } from "./brain";
import { createBrainMcpServer } from "./mcp";
import { PgBrain } from "./pg";

const databaseUrl = process.env.DATABASE_URL;
const dir = process.env.BRAIN_DIR;
if (!databaseUrl && !dir) {
  console.error("DATABASE_URL or BRAIN_DIR is required");
  process.exit(1);
}

const brain: Brain = databaseUrl
  ? new PgBrain(new pg.Pool({ connectionString: databaseUrl, max: 2 }))
  : new GitBrain({ dir: dir! });
if (!databaseUrl) await brain.init();
await createBrainMcpServer(brain).connect(new StdioServerTransport());
