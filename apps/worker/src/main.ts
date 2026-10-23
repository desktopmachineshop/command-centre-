import { createWorker, loadConfig } from "./index";

/**
 * `cc-worker [--config path] [--server url] [--token t] [--name n] [--work-dir d]
 *  [--capabilities ffmpeg,gpu] [--status-json]`
 * With --status-json, status changes are printed as `CC_STATUS {...}` lines for the desktop app.
 */
async function main() {
  const config = loadConfig();
  const client = await createWorker(config, {
    onStatus: config.statusJson ? (s) => process.stdout.write(`CC_STATUS ${JSON.stringify(s)}\n`) : undefined,
  });
  console.log(`[worker] config ${config.configPath}, node ${config.nodeId}, server ${config.wsUrl}`);
  client.start();

  const shutdown = () => {
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[worker] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
