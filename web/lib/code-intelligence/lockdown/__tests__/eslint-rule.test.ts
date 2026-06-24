/**
 * Code Intelligence v2 — Phase 0.2
 * RuleTester coverage for `inariwatch/no-direct-code-intel-db`.
 *
 * Note: ESLint's RuleTester registers cases as `describe`/`it` blocks of
 * its own. It must be invoked at the top level — wrapping it inside a
 * vitest `describe` triggers "Calling the suite function inside test
 * function is not allowed". Same pattern as ai-router/lockdown.test.ts.
 */

import { RuleTester } from "eslint";

import lockdown from "../eslint-rule.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-direct-code-intel-db", lockdown.rule, {
  valid: [
    // The service layer itself is the SSOT — must keep direct access.
    {
      filename: "/repo/web/lib/services/code-intelligence.service.ts",
      code: `import { codeRepositories, codeChunks } from "@/lib/db";`,
    },
    // The v1 module that owns the legacy tables.
    {
      filename: "/repo/web/lib/code-intelligence/indexer.ts",
      code: `import { codeChunks, codeRepositories, codeDependencies } from "@/lib/db";`,
    },
    // The v2 module that owns the new semantic-graph tables (Phase 1.5).
    {
      filename: "/repo/web/lib/code-intelligence-v2/persist.ts",
      code: `import { codeSymbols, codeReferences, codeTypeFacts, codeImports } from "@/lib/db/schema";`,
    },
    // The v2 module also owns the shadow log.
    {
      filename: "/repo/web/lib/code-intelligence-v2/queries.ts",
      code: `import { codeIntelShadowLog } from "@/lib/db";`,
    },
    // Schema definition site.
    {
      filename: "/repo/web/lib/db/schema.ts",
      code: `export const codeChunks = pgTable("code_chunks", {});`,
    },
    // Migration tests.
    {
      filename: "/repo/web/lib/db/__tests__/migration-0079.test.ts",
      code: `import { codeSymbols } from "@/lib/db";`,
    },
    // Generic __tests__ folders may stub the tables.
    {
      filename: "/repo/web/app/api/foo/__tests__/route.test.ts",
      code: `import { codeChunks, codeSymbols } from "@/lib/db";`,
    },
    // Importing OTHER tables from @/lib/db is fine.
    {
      filename: "/repo/web/app/api/foo/route.ts",
      code: `import { db, projects } from "@/lib/db";`,
    },
    // Importing the service helpers is the canonical path.
    {
      filename: "/repo/web/app/api/foo/route.ts",
      code: `import { findIndexedRepoIdentity } from "@/lib/services/code-intelligence.service";`,
    },
    // Phase 3.2 / 3.3 — admin code-intel routes can read telemetry tables.
    {
      filename: "/repo/web/app/api/admin/code-intel/cutover-status/route.ts",
      code: `import { codeIntelRemediationAb, codeIntelShadowLog } from "@/lib/db";`,
    },
    // Phase 3.2 / 3.3 — cutover eval script (one-off CLI) reads telemetry directly.
    {
      filename: "/repo/web/scripts/code-intel-v2-cutover-eval.ts",
      code: `import { codeIntelRemediationAb } from "@/lib/db";`,
    },
    // Phase 3.1 — shadow seed script reads through the service, but the
    // dedicated allowlist entry exists for symmetry with the cutover script.
    {
      filename: "/repo/web/scripts/seed-shadow-run.ts",
      code: `import { codeIntelShadowLog } from "@/lib/db";`,
    },
  ],
  invalid: [
    // Direct named import in a route — the canonical violation.
    {
      filename: "/repo/web/app/api/replay/route.ts",
      code: `import { codeRepositories } from "@/lib/db";`,
      errors: [{ messageId: "directTableImport" }],
    },
    // Multiple in one statement should each report.
    {
      filename: "/repo/web/app/api/foo/route.ts",
      code: `import { codeChunks, codeDependencies } from "@/lib/db";`,
      errors: [
        { messageId: "directTableImport" },
        { messageId: "directTableImport" },
      ],
    },
    // From @/lib/db/schema directly.
    {
      filename: "/repo/web/app/api/foo/route.ts",
      code: `import { codeRepositories } from "@/lib/db/schema";`,
      errors: [{ messageId: "directTableImport" }],
    },
    // Dynamic import destructuring (the webhook used to do this).
    {
      filename: "/repo/web/app/api/webhooks/foo/route.ts",
      code: `async function f() { const { codeRepositories } = await import("@/lib/db"); }`,
      errors: [{ messageId: "directTableImport" }],
    },
    // v2 tables blocked outside the v2 module (Phase 1.5).
    {
      filename: "/repo/web/app/api/admin/route.ts",
      code: `import { codeSymbols } from "@/lib/db";`,
      errors: [{ messageId: "directTableImport" }],
    },
    {
      filename: "/repo/web/app/api/admin/route.ts",
      code: `import { codeReferences, codeTypeFacts, codeImports } from "@/lib/db";`,
      errors: [
        { messageId: "directTableImport" },
        { messageId: "directTableImport" },
        { messageId: "directTableImport" },
      ],
    },
    {
      filename: "/repo/web/app/api/admin/ops/route.ts",
      code: `import { codeIntelShadowLog } from "@/lib/db";`,
      errors: [{ messageId: "directTableImport" }],
    },
    // Phase 3.2 — codeIntelRemediationAb is forbidden outside the allowlist.
    {
      filename: "/repo/web/app/api/admin/route.ts",
      code: `import { codeIntelRemediationAb } from "@/lib/db";`,
      errors: [{ messageId: "directTableImport" }],
    },
    // Other scripts (not the cutover prefix) cannot import telemetry tables.
    {
      filename: "/repo/web/scripts/some-other-script.ts",
      code: `import { codeIntelRemediationAb } from "@/lib/db";`,
      errors: [{ messageId: "directTableImport" }],
    },
  ],
});
