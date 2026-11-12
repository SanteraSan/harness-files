import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    isolate: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
