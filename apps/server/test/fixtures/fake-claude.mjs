#!/usr/bin/env node
// Stands in for `claude setup-token` in tests: a terminal UI that prints a sign-in URL,
// reads a code in raw mode, and prints a token (or an error for the code "bad").
if (process.argv[2] !== "setup-token") process.exit(2);
const out = (s) => process.stdout.write(s);
out("\x1b[2J\x1b[1m Welcome to Claude Code \x1b[0m\r\n");
out("Browser didn't open? Use the url below to sign in:\r\n\r\n");
out(`\x1b[36mhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=${"s".repeat(40)}\x1b[0m\r\n\r\n`);
out("Paste code here if prompted > ");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let code = "";
process.stdin.on("data", (b) => {
  for (const ch of b.toString()) {
    if (ch === "\r" || ch === "\n") {
      if (code === "bad") {
        out("\r\nOAuth error: invalid code\r\n");
        process.exit(1);
      }
      out(`\r\n\x1b[32m✓ Long-lived authentication token created successfully!\x1b[0m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\nsk-ant-oat01-${Buffer.from(code).toString("hex")}AAAAAAAAAAAAAAAAAAAAAAAA\r\n\r\nStore this token securely.\r\n`);
      setTimeout(() => process.exit(0), 50);
      return;
    }
    code += ch;
  }
});
