// ESLint flat config — web app.
//
// Enforces the v0.3 AI router lockdown rule. Per INARI_AI_ARCHITECTURE.md §9,
// no file outside `packages/ai-router/src/providers/` may import a provider
// SDK or fetch a provider URL directly. Violations are CI errors.
//
// As of v0.3 S2.5 every prior carve-out has been migrated through the router
// (stream chat, validateKey, Graders, Managed Agents, chaos test). New
// integrations MUST add a task in `packages/ai-router/src/tasks.ts` + a
// rule in `rules.ts` — never an eslint-disable.

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
