import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  // Workspace packages ship TypeScript source, so they are bundled in. Every npm
  // package stays external, so the server must list the ones @cc/* packages use.
  noExternal: [/^@cc\//],
  external: [/^(?!@cc\/)[^./]/],
  clean: true,
  sourcemap: true,
});
