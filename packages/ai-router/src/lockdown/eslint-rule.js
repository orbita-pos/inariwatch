/**
 * inariwatch/no-direct-ai-sdk-import — ESLint custom rule.
 *
 * Per INARI_AI_ARCHITECTURE.md §9 (LOCKED 2026-05-02), every AI provider call
 * in the monorepo must go through `@inariwatch/ai-router` dispatch(). This
 * rule enforces the boundary in CI by failing the build whenever a file
 * outside `packages/ai-router/src/providers/`:
 *
 *   1. Imports a provider SDK (openai, @anthropic-ai/sdk, groq-sdk,
 *      @google/generative-ai, grok-sdk, @deepseek/sdk).
 *   2. Calls fetch() to a provider URL (api.anthropic.com, api.openai.com,
 *      api.x.ai, api.groq.com, api.deepseek.com, generativelanguage.googleapis.com).
 *
 * Both lockdowns matter — today's fetch-based pattern would slip past an
 * SDK-only check.
 */

const SDK_PACKAGES = new Set([
  "openai",
  "@anthropic-ai/sdk",
  "groq-sdk",
  "@google/generative-ai",
  "grok-sdk",
  "@deepseek/sdk",
  "@x-ai/sdk",
]);

const PROVIDER_URL_PATTERNS = [
  /\bapi\.anthropic\.com\b/,
  /\bapi\.openai\.com\b/,
  /\bapi\.x\.ai\b/,
  /\bapi\.groq\.com\b/,
  /\bapi\.deepseek\.com\b/,
  /\bgenerativelanguage\.googleapis\.com\b/,
];

const ALLOWLIST_PATH_FRAGMENT = "packages/ai-router/src/providers";

/**
 * Returns true when the given absolute filename lives inside the
 * providers/ allowlist. Tolerant of Windows backslash paths.
 */
function isAllowlisted(filename) {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/");
  return normalized.includes(ALLOWLIST_PATH_FRAGMENT);
}

/** True for the `<rules-package>/src/lockdown/__fixtures__` test dir. */
function isFixture(filename) {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/");
  return normalized.includes("/lockdown/__fixtures__/");
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Block direct AI provider SDK imports and raw provider URL fetches outside packages/ai-router/src/providers/",
      recommended: true,
    },
    schema: [],
    messages: {
      sdkImport:
        'Direct import of provider SDK "{{name}}" is forbidden outside packages/ai-router/src/providers/. Use dispatch() from @inariwatch/ai-router instead.',
      providerUrl:
        'Direct reference to provider URL "{{url}}" is forbidden outside packages/ai-router/src/providers/. Use dispatch() from @inariwatch/ai-router instead.',
    },
  },
  create(context) {
    const filename =
      typeof context.filename === "string"
        ? context.filename
        : typeof context.getFilename === "function"
          ? context.getFilename()
          : "";

    if (isAllowlisted(filename) || isFixture(filename)) {
      return {};
    }

    function checkStringForUrl(node, value) {
      if (typeof value !== "string") return;
      for (const pattern of PROVIDER_URL_PATTERNS) {
        const m = value.match(pattern);
        if (m) {
          context.report({
            node,
            messageId: "providerUrl",
            data: { url: m[0] },
          });
          return;
        }
      }
    }

    return {
      ImportDeclaration(node) {
        const source = node.source && node.source.value;
        if (typeof source !== "string") return;
        if (SDK_PACKAGES.has(source)) {
          context.report({
            node: node.source,
            messageId: "sdkImport",
            data: { name: source },
          });
        }
      },
      // `import("openai")` dynamic imports
      ImportExpression(node) {
        const arg = node.source;
        if (arg && arg.type === "Literal" && SDK_PACKAGES.has(arg.value)) {
          context.report({
            node: arg,
            messageId: "sdkImport",
            data: { name: arg.value },
          });
        }
      },
      // `require("openai")` for CJS
      CallExpression(node) {
        if (
          node.callee &&
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal" &&
          SDK_PACKAGES.has(node.arguments[0].value)
        ) {
          context.report({
            node: node.arguments[0],
            messageId: "sdkImport",
            data: { name: node.arguments[0].value },
          });
        }
      },
      Literal(node) {
        checkStringForUrl(node, node.value);
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          checkStringForUrl(node, quasi.value && quasi.value.cooked);
        }
      },
    };
  },
};

// Plugin object — exported under the "inariwatch" namespace so an ESLint
// flat config can reference it as `inariwatch/no-direct-ai-sdk-import`.
// ESM default export so `web/eslint.config.mjs` can `import inariwatchAiRouter from ...`.
export default {
  rules: {
    "no-direct-ai-sdk-import": rule,
  },
  /** Direct rule export, useful for unit tests via RuleTester. */
  rule,
  // Allowlist + URL set re-exported for tests.
  SDK_PACKAGES: Array.from(SDK_PACKAGES),
  PROVIDER_URL_PATTERNS,
  ALLOWLIST_PATH_FRAGMENT,
};
