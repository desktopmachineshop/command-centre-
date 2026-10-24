/**
 * Gets a Google Calendar refresh token, once, on Dave's PC:
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... pnpm --filter @cc/pa google:auth [--scopes calendar.events,drive.file]
 *
 * By default it asks for the calendar scopes plus drive.file, so the one
 * refresh token (GOOGLE_REFRESH_TOKEN) serves Calendar and Drive storage.
 * It listens on a random 127.0.0.1 port, opens Google's consent page, takes the
 * code Google redirects back with, exchanges it (with PKCE), and prints the
 * refresh token, the calendars the account can see, and a ready CALENDAR_ACCOUNTS entry.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildAuthUrl, exchangeCode, listCalendars, parseScopes, pkcePair } from "../google-auth";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i]!.includes("=") ? args[i]!.split("=").slice(1).join("=") : args[i + 1];
};
const clientId = process.env.GOOGLE_CLIENT_ID ?? flag("client-id");
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? flag("client-secret");
const scopes = parseScopes(flag("scopes"));
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (from your Desktop app OAuth client), then run again.");
  process.exit(1);
}

const { verifier, challenge } = pkcePair();
const state = randomBytes(16).toString("hex");

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const authUrl = buildAuthUrl({ clientId, redirectUri, challenge, state, scopes });
console.log(`Scopes: ${scopes.join(" ")}`);

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    if (!got && !error) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    if (error || url.searchParams.get("state") !== state) {
      res.end("Google did not grant access. You can close this tab.");
      reject(new Error(error ?? "state mismatch"));
      return;
    }
    res.end("Done. You can close this tab and go back to the terminal.");
    resolve(got!);
  });
  console.log(`\nOpen this URL in a browser signed in to the Google account whose calendar the PA should use:\n\n${authUrl}\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(opener, [authUrl], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser launcher: the printed URL is enough.
  }
});
server.close();

const tokens = await exchangeCode({ clientId, clientSecret, code, verifier, redirectUri });
const calendars = await listCalendars(tokens.accessToken);

console.log("\nRefresh token (keep it secret: it opens your calendar and the app's Drive files). Set it on Railway as:\n");
console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refreshToken}`);
console.log(`\nGranted scopes: ${tokens.scope}`);
if (calendars.length) {
  console.log("\nCalendars this account can see (use the id in CALENDAR_ACCOUNTS):");
  for (const c of calendars) console.log(`  ${c.primary ? "primary" : c.id}  ${c.summary}  (${c.accessRole})`);
}
const example = [
  {
    id: "google",
    provider: "google",
    vertical: "personal",
    // Shared and family calendars too, so they count for free/busy; read-only ones can't take new events.
    calendars: [
      "primary",
      ...calendars
        .filter((c) => !c.primary && c.accessRole !== "freeBusyReader")
        .slice(0, 5)
        .map((c) => ({ id: c.id, name: c.summary, ...(["owner", "writer"].includes(c.accessRole) ? {} : { write: false }) })),
    ],
  },
];
console.log(`\nExample CALENDAR_ACCOUNTS (one line; credentials default to GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN):\n\n${JSON.stringify(example)}\n`);
