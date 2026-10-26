import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const server = process.env.CC_SERVER_URL ?? "http://localhost:8080";

/** Which build this is: the commit Railway builds, else the local one, else the build time. */
function buildId(): string {
  const fromEnv = process.env.CC_BUILD_ID || process.env.RAILWAY_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return `t${Date.now().toString(36)}`;
  }
}
const BUILD_ID = buildId();

/** dist/version.json: the installed app compares it with its own id to notice a deploy (src/update.ts). */
const versionFile: Plugin = {
  name: "cc-version",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ id: BUILD_ID })}\n` });
  },
};

export default defineConfig({
  plugins: [react(), versionFile],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5173,
    // In dev the PWA talks to a local server through the Vite proxy.
    proxy: {
      "/api": server,
      "/media": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
