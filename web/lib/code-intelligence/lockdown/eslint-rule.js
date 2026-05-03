/**
 * inariwatch/no-direct-code-intel-db — ESLint custom rule.
 *
 * Phase 0.2 of Code Intelligence v2: every consumer of the
 * code_chunks / code_repositories / code_dependencies tables must go
 * through `web/lib/services/code-intelligence.service.ts`.
 *
 * Phase 1.5 extends the rule to v2 tables (code_symbols / code_references /
 * code_type_facts / code_imports / code_intel_shadow_log) — same boundary,
 * same SSOT — and adds `web/lib/code-intelligence-v2/**` to the allowlist
 * since that module owns those tables.
 *
 * Without this boundary, v2 cannot replace the underlying schema in-place
 * (see `radar/CODE_INTELLIGENCE_V2_HANDOFF.md`) — every direct caller would
 * be a hidden migration site. This rule is the spine that lets the service
 * swap engines (v1 statistical → v2 semantic) without touching consumers.
 *
 * Allowlist (anywhere on the path):
 *   - web/lib/code-intelligence/**            (v1 module owns code_chunks etc.)
 *   - web/lib/code-intelligence-v2/**         (v2 module owns code_symbols etc.)
 *   - web/lib/services/code-intelligence.service.ts (the service layer SSOT)
 *   - web/lib/db/schema.ts                    (the table definitions themselves)
 *   - web/lib/db/index.ts                     (re-export of the schema)
 *   - web/lib/db/__tests__/**                 (migration shape tests)
 *   - any **\/__tests__\/**                   (general unit tests with mocks)
 */

const FORBIDDEN_NAMED_IMPORTS = new Set([
  // v1 (Phase 0.2)
  "codeChunks",
  "codeRepositories",
  "codeDependencies",
  // v2 (Phase 1.5)
  "codeSymbols",
  "codeReferences",
  "codeTypeFacts",
  "codeImports",
  "codeIntelShadowLog",
]);

const FORBIDDEN_SOURCES = new Set([
  "@/lib/db",
  "@/lib/db/schema",
]);

const ALLOWLIST_PATH_FRAGMENTS = [
  "web/lib/code-intelligence/",
  "web/lib/code-intelligence-v2/",
  "web/lib/services/code-intelligence.service.ts",
  "web/lib/db/schema.ts",
  "web/lib/db/index.ts",
  "web/lib/db/__tests__/",
  "/__tests__/",
];

function isAllowlisted(filename) {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWLIST_PATH_FRAGMENTS.some((frag) => normalized.includes(frag));
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Block direct named imports of codeChunks / codeRepositories / codeDependencies from @/lib/db. Use lib/services/code-intelligence.service.ts instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      directTableImport:
        'Direct import of "{{name}}" from "{{source}}" is forbidden outside the code-intelligence module. Use lib/services/code-intelligence.service.ts (add a helper there if needed).',
    },
  },
  create(context) {
    const filename =
      typeof context.filename === "string"
        ? context.filename
        : typeof context.getFilename === "function"
          ? context.getFilename()
          : "";

    if (isAllowlisted(filename)) {
      return {};
    }

    function checkImportSource(node, source) {
      if (typeof source !== "string") return;
      if (!FORBIDDEN_SOURCES.has(source)) return;

      const specifiers = node.specifiers || [];
      for (const spec of specifiers) {
        // Only ImportSpecifier carries `imported` (named imports).
        if (spec.type !== "ImportSpecifier" || !spec.imported) continue;
        const importedName = spec.imported.name;
        if (FORBIDDEN_NAMED_IMPORTS.has(importedName)) {
          context.report({
            node: spec,
            messageId: "directTableImport",
            data: { name: importedName, source },
          });
        }
      }
    }

    return {
      ImportDeclaration(node) {
        const source = node.source && node.source.value;
        checkImportSource(node, source);
      },
      // `const { codeRepositories } = await import("@/lib/db")`
      VariableDeclarator(node) {
        if (
          !node.init ||
          node.init.type !== "AwaitExpression" ||
          !node.init.argument ||
          node.init.argument.type !== "ImportExpression"
        )
          return;
        const importExpr = node.init.argument;
        const sourceArg = importExpr.source;
        if (!sourceArg || sourceArg.type !== "Literal") return;
        const source = sourceArg.value;
        if (!FORBIDDEN_SOURCES.has(source)) return;
        if (!node.id || node.id.type !== "ObjectPattern") return;
        for (const prop of node.id.properties) {
          if (prop.type !== "Property" || !prop.key) continue;
          const keyName =
            prop.key.type === "Identifier"
              ? prop.key.name
              : prop.key.type === "Literal"
                ? prop.key.value
                : null;
          if (keyName && FORBIDDEN_NAMED_IMPORTS.has(keyName)) {
            context.report({
              node: prop,
              messageId: "directTableImport",
              data: { name: keyName, source },
            });
          }
        }
      },
    };
  },
};

// Plugin object — registered under the "inariwatch" namespace alongside the
// AI router lockdown rule. ESM default export so `web/eslint.config.mjs`
// can `import inariwatchCodeIntel from ...`.
export default {
  rules: {
    "no-direct-code-intel-db": rule,
  },
  rule,
  FORBIDDEN_NAMED_IMPORTS: Array.from(FORBIDDEN_NAMED_IMPORTS),
  FORBIDDEN_SOURCES: Array.from(FORBIDDEN_SOURCES),
  ALLOWLIST_PATH_FRAGMENTS,
};
