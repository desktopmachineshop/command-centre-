import { findBrowser, playwrightScript, runPlaywrightScript } from "./browser";
import { createWorker, loadConfig, RedditBrowser, redditProfileDir } from "./index";

/**
 * `cc-worker [--config path] [--server url] [--token t] [--name n] [--work-dir d]
 *  [--capabilities ffmpeg,gpu] [--status-json]`
 * With --status-json, status changes are printed as `CC_STATUS {...}` lines for the desktop app,
 * and an update pushed from the Devices page as a `CC_UPDATE` line (the app then installs it).
 *
 * `cc-worker reddit-login [--config path]`: opens the Reddit window's own Chrome profile at the
 * login page and waits (up to 10 minutes) for Dave to sign in there himself; the same as Sign in
 * to Reddit on the Devices page. Run it while the worker isn't posting (one window per profile).
 */
async function main() {
  const config = loadConfig();
  const client = await createWorker(config, {
    onStatus: config.statusJson ? (s) => process.stdout.write(`CC_STATUS ${JSON.stringify(s)}\n`) : undefined,
    onUpdate: config.statusJson ? () => process.stdout.write("CC_UPDATE\n") : undefined,
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
} else if (process.argv[2] === "reddit-login") {
  redditLogin(process.argv.slice(3)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[reddit] ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    },
  );
} else {
  start();
}

async function redditLogin(argv: string[]): Promise<number> {
  const config = loadConfig(argv);
  const reddit = new RedditBrowser({ chromiumBin: findBrowser(config.chromiumBin), profileDir: redditProfileDir(config), log: (line) => console.log(line) });
  console.log("[reddit] A Chrome window is opening at old.reddit.com/login: sign in there with your Reddit account (this program never sees the password).");
  try {
    const result = await reddit.run({ op: "login", timeoutSec: 600 });
    if (result.ok) {
      console.log(`[reddit] Signed in as u/${result.user.name}. Command Centre posts from this window once you add a "Reddit (posts from my PC)" account.`);
      return 0;
    }
    console.error(`[reddit] ${result.message}`);
    return 1;
  } finally {
    await reddit.close();
  }
}

function start() {
  main().catch((err) => {
    console.error(`[worker] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
