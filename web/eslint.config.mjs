// ESLint flat config — web app.
//
// Sole purpose in S1: enforce the v0.3 AI router lockdown rule.
// Per INARI_AI_ARCHITECTURE.md §9, no file outside
// `packages/ai-router/src/providers/` may import a provider SDK or fetch a
// provider URL directly. Violations are CI errors. Documented carve-outs
// use file-level `/* eslint-disable inariwatch/no-direct-ai-sdk-import */`
// or per-line disables — both are tracked as v0.3 S2 follow-ups.

import inariwatchAiRouter from "../packages/ai-router/src/lockdown/eslint-rule.js";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      "out/**",
      ".vercel/**",
      "playwright-report/**",
      "test-results/**",
      "scripts/demo-output/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
    plugins: {
      inariwatch: inariwatchAiRouter,
    },
    rules: {
      "inariwatch/no-direct-ai-sdk-import": "error",
    },
  },
];
