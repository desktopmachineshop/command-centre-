#!/usr/bin/env node
// Brain MCP server over stdio. Configure with BRAIN_DIR and optional BRAIN_REMOTE_URL.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Brain } from "./brain";
import { createBrainMcpServer } from "./mcp";

const dir = process.env.BRAIN_DIR;
if (!dir) {
  console.error("BRAIN_DIR is required");
  process.exit(1);
}

const brain = new Brain({ dir, remoteUrl: process.env.BRAIN_REMOTE_URL || undefined });
await brain.init();
await createBrainMcpServer(brain).connect(new StdioServerTransport());
