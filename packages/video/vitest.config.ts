import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Capture and render tests launch Chromium and ffmpeg; keep them sequential.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
