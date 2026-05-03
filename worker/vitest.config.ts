// Vitest config for the worker — tests are normally run via `node --test`
// (`npm test` script) with tsx, but we don't ship tsx in this disk-tight
// dev environment. Vitest is already in web/node_modules (junctioned here),
// so we use it as a pragmatic test runner.
//
// The worker tests use `node:test` and `node:assert/strict`; vitest in node
// environment honors both. This config stays additive — `npm test` (tsx)
// remains the canonical way once tsx is available.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
