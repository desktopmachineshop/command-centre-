#!/usr/bin/env node
// Stands in for the `codex` CLI in tests.
// `codex login --device-auth`: prints the device link and code as codex-cli 0.167 does, then
//   "signs in" (writes CODEX_HOME/auth.json) and exits; FAKE_CODEX_LOGIN=fail makes it give up.
// `codex exec --json`: answers from CODEX_HOME/auth.json, whose refresh token picks the behaviour:
//   "limit" = a usage limit; "rotate" = refreshes its tokens (rewrites auth.json); else answers.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
const [cmd, ...rest] = process.argv.slice(2);
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

if (cmd === "login" && rest.includes("--device-auth")) {
  const out = (s) => process.stdout.write(s);
  out("\x1b[1mWelcome to Codex\x1b[0m [v0.167.0]\nOpenAI's command-line coding agent\n\n");
  out("Follow these steps to sign in with ChatGPT using device code authorization:\n\n");
  out("1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n");
  out("2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mWXYZ-12345\x1b[0m\n\n");
  out("Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.\n");
  setTimeout(() => {
    if (process.env.FAKE_CODEX_LOGIN === "fail") {
      process.stderr.write("Error: device code expired\n");
      process.exit(1);
    }
    const auth = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: jwt({ email: "dave@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }), access_token: "at-secret-1", refresh_token: "rt-secret-1", account_id: "acc-1" },
      last_refresh: "2026-11-06T00:00:00Z",
    };
    writeFileSync(join(home, "auth.json"), JSON.stringify(auth, null, 2));
    out("Successfully logged in\n");
    process.exit(0);
  }, 300);
} else if (cmd === "exec") {
  let prompt = "";
  process.stdin.on("data", (d) => (prompt += d));
  process.stdin.on("end", () => {
    const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
    let auth = null;
    try {
      auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    } catch {}
    out({ type: "thread.started", thread_id: "thread-1" });
    out({ type: "turn.started" });
    const rt = auth?.tokens?.refresh_token;
    if (!rt) {
      out({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
      process.exit(1);
    }
    if (rt === "limit") {
      out({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } });
      process.exit(1);
    }
    if (rt === "rotate") writeFileSync(join(home, "auth.json"), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "rotated" } }));
    out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: `codex: ${prompt}` } });
    out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  });
} else {
  process.exit(2);
}
