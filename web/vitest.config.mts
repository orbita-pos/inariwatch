import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // React plugin handles JSX/TSX transforms (incl. the automatic JSX
  // runtime so `import React from "react"` is unnecessary). Sesión 29
  // adds the first .tsx vitest spec — the page test for /verify.
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Point @inariwatch/capture at the local workspace dist so payload v2
      // SDK changes are tested before publish. Runtime (Next) still resolves
      // the published npm version.
      "@inariwatch/capture": path.resolve(__dirname, "../capture/dist/index.js"),
      // v0.3 S1 — internal AI router package. Lives in the monorepo at
      // packages/ai-router/, never published. Aliased to TS source so vitest
      // doesn't need a build step.
      "@inariwatch/ai-router": path.resolve(__dirname, "../packages/ai-router/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    exclude: ["__tests__/**/*.spec.ts", "node_modules/**"],
  },
});
