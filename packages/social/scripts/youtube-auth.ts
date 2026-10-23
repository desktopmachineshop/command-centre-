/**
 * `pnpm --filter @cc/social youtube:auth`
 *
 * Runs Google's OAuth 2.0 installed-app flow on this machine and prints the refresh token and
 * channel id for a YouTube account in SOCIAL_ACCOUNTS. It listens on a random port on 127.0.0.1
 * for the redirect (the loopback flow), so run it on a computer with a browser, never on the server.
 *
 *   YT_CLIENT_ID=... YT_CLIENT_SECRET=... pnpm --filter @cc/social youtube:auth
 *
 * Optional: YT_LOGIN_HINT=<google account email> pre-selects the account. Sign in as the Google
 * account that owns (or manages) the channel; for a Brand Account channel, pick the channel when
 * Google asks.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildAuthUrl, createPkce, exchangeCode, fetchOwnChannels } from "../src/adapters/youtube/oauth";

const TIMEOUT_MS = 5 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const clientId = process.env.YT_CLIENT_ID ?? arg("client-id");
  const clientSecret = process.env.YT_CLIENT_SECRET ?? arg("client-secret");
  if (!clientId || !clientSecret) {
    console.error(
      "Set YT_CLIENT_ID and YT_CLIENT_SECRET (a Google Cloud OAuth client of type \"Desktop app\"), e.g.\n" +
        "  YT_CLIENT_ID=123.apps.googleusercontent.com YT_CLIENT_SECRET=GOCSPX-... pnpm --filter @cc/social youtube:auth\n" +
        "See docs/SETUP.md, \"Social: platform setup\" → YouTube.",
    );
    process.exit(2);
  }

  const pkce = createPkce();
  const state = randomBytes(16).toString("hex");
  let redirectUri = "";

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      const ok = !error && got && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
      res.end(ok ? "Command Centre: YouTube access granted. You can close this tab." : `Command Centre: authorisation failed (${error ?? "bad state"}).`);
      clearTimeout(timer);
      server.close();
      if (ok) resolve(got);
      else reject(new Error(error ? `Google returned "${error}"` : "the redirect's state didn't match; try again"));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("timed out after 5 minutes waiting for the browser"));
    }, TIMEOUT_MS);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = buildAuthUrl({ clientId, redirectUri, state, challenge: pkce.challenge, loginHint: process.env.YT_LOGIN_HINT });
      console.log("Open this URL in a browser on this computer and allow access:\n");
      console.log(`  ${url}\n`);
      console.log(`Waiting for Google to redirect to ${redirectUri} ...`);
    });
  });

  const tokens = await exchangeCode(fetch, { clientId, clientSecret, code, verifier: pkce.verifier, redirectUri });
  const missing = ["youtube.upload", "youtube.force-ssl"].filter((s) => !tokens.scope.some((g) => g.endsWith(`/auth/${s}`)));
  if (missing.length) console.warn(`\nWarning: Google didn't grant ${missing.join(" and ")}; uploads or comments will fail. Run this again and tick every box.`);

  let channels: { id: string; title: string; customUrl?: string }[] = [];
  try {
    channels = await fetchOwnChannels(fetch, tokens.accessToken);
  } catch (err) {
    console.warn(`\nCouldn't look up the channel id (${(err as Error).message}); find it in YouTube Studio → Settings → Channel → Advanced settings.`);
  }
  const channel = channels[0];

  console.log("\nRefresh token (keep it secret, it grants access to the channel):\n");
  console.log(`  ${tokens.refreshToken}\n`);
  if (channels.length > 1) console.log(`This login manages ${channels.length} channels: ${channels.map((c) => `${c.title} (${c.id})`).join(", ")}. The token acts as the one chosen at sign-in.`);
  if (channel) console.log(`Channel: ${channel.title}${channel.customUrl ? ` (${channel.customUrl})` : ""}, id ${channel.id}\n`);
  console.log("SOCIAL_ACCOUNTS entry (one line in the variable):\n");
  console.log(
    JSON.stringify(
      {
        id: "3dp-youtube",
        platform: "youtube",
        vertical: "3dpandme",
        handle: channel?.customUrl ?? "<@handle>",
        credentials: { clientId, clientSecret: "<client secret>", refreshToken: tokens.refreshToken, channelId: channel?.id ?? "<UC... channel id>" },
        options: { defaultCategoryId: "28" },
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error(`youtube:auth failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
