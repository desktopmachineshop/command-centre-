import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Store tests share one Postgres schema, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
