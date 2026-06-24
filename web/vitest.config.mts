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
      // Code Intelligence v2 (Phase 1.2) — internal extractor binary. Same
      // alias pattern as the AI router. CLI at src/cli.ts is the spawn entry;
      // persist.ts imports the in-process API from src/index.ts.
      "@inariwatch/code-intel-extractor-ts": path.resolve(__dirname, "../packages/code-intel-extractor-ts/src/index.ts"),
      // Code Intelligence v2 (Phase 2.2) — Python extractor. Multi-language
      // dispatch in `lib/code-intelligence-v2/multi-extractor.ts` chooses
      // between this and the TS extractor per-file.
      "@inariwatch/code-intel-extractor-py": path.resolve(__dirname, "../packages/code-intel-extractor-py/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    exclude: ["__tests__/**/*.spec.ts", "node_modules/**"],
  },
});
