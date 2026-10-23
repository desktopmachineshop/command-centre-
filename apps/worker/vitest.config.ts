import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share the server's Postgres database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
