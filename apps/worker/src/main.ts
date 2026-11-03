import { playwrightScript, runPlaywrightScript } from "./browser";
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

// Playwright runs its own scripts with `process.execPath`: its installer (browser.ts,
// installRecorder) and the download helper it forks. Inside the desktop app's single
// executable that's this worker, so run the script instead of starting the worker.
if (playwrightScript(process.argv[2])) {
  runPlaywrightScript(process.argv[2]!, process.argv.slice(3));
} else {
  start();
}

function start() {
  main().catch((err) => {
    console.error(`[worker] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
