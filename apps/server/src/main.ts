import { serve } from "@hono/node-server";
import { createServer } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const server = createServer(config);
await server.start();

const http = serve({ fetch: server.app.fetch, port: config.port }, (info) => {
  console.log(`command centre listening on :${info.port} (runner: ${config.agent.runner})`);
});
server.injectWebSocket(http);

const shutdown = async (signal: string) => {
  console.log(`${signal}: shutting down`);
  http.close();
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
