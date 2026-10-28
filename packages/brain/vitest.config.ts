import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Postgres tests share one scratch schema, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
