import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./__tests__",
  fullyParallel: false,
  retries: 1,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
