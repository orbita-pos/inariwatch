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
import inariwatchCodeIntel from "./lib/code-intelligence/lockdown/eslint-rule.js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooksPlugin from "eslint-plugin-react-hooks";

// Two custom rules are merged under the same `inariwatch` plugin namespace
// so flat config can reference them as `inariwatch/<rule>`. Rules enforced:
//   - inariwatch/no-direct-ai-sdk-import   (v0.3 S1 — AI router lockdown)
//   - inariwatch/no-direct-code-intel-db   (Code Intel v2 Phase 0.2)
// `@typescript-eslint`, `@next/next`, `react-hooks` are registered but with
// NO rules enforced — they exist so legacy inline pragmas resolve cleanly.
const inariwatchPlugin = {
  rules: {
    ...inariwatchAiRouter.rules,
    ...inariwatchCodeIntel.rules,
  },
};

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
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: {
      inariwatch: inariwatchPlugin,
      "@typescript-eslint": tsPlugin,
      "@next/next": nextPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      "inariwatch/no-direct-ai-sdk-import": "error",
      "inariwatch/no-direct-code-intel-db": "error",
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    plugins: {
      inariwatch: inariwatchPlugin,
    },
    rules: {
      "inariwatch/no-direct-ai-sdk-import": "error",
      "inariwatch/no-direct-code-intel-db": "error",
    },
  },
];
