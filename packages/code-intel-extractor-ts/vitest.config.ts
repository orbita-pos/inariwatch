import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["src/__tests__/fixtures/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
