import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["src/__tests__/fixtures/**"],
    environment: "node",
    // pyright-langserver cold-start + analysis on first request can take
    // 1-3 seconds on Windows even for a 5-line file. Per-test budget kept
    // generous so a slow CI box doesn't flake the suite.
    testTimeout: 60_000,
  },
});
