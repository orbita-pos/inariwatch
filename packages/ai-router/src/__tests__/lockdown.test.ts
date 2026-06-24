import { RuleTester } from "eslint";
import { describe, it } from "vitest";

// ESM default export — eslint-rule.js exports
// `{ rules, rule, SDK_PACKAGES, PROVIDER_URL_PATTERNS, ALLOWLIST_PATH_FRAGMENT }`.
import lockdown from "../lockdown/eslint-rule.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("inariwatch/no-direct-ai-sdk-import", () => {
  it("passes valid + invalid fixtures", () => {
    tester.run("no-direct-ai-sdk-import", lockdown.rule, {
      valid: [
        // Imports of non-SDK modules are fine.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `import { dispatch } from "@inariwatch/ai-router";`,
        },
        // Files inside the providers/ allowlist may import SDKs.
        {
          filename: "/repo/packages/ai-router/src/providers/openai.ts",
          code: `import OpenAI from "openai";`,
        },
        // Files inside the providers/ allowlist may fetch provider URLs.
        {
          filename: "/repo/packages/ai-router/src/providers/anthropic.ts",
          code: `fetch("https://api.anthropic.com/v1/messages");`,
        },
        // Together AI URL inside the allowlist is fine.
        {
          filename: "/repo/packages/ai-router/src/providers/together.ts",
          code: `fetch("https://api.together.xyz/v1/chat/completions");`,
        },
        // Lockdown __fixtures__ are explicitly exempt (RuleTester fixtures).
        {
          filename: "/repo/packages/ai-router/src/lockdown/__fixtures__/synthetic-violation.ts",
          code: `import OpenAI from "openai";`,
        },
        // String matching only flags provider URL substrings.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `const url = "https://example.com/api";`,
        },
        // Unrelated package import.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `import { z } from "zod";`,
        },
      ],
      invalid: [
        // SDK import outside the allowlist.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `import OpenAI from "openai";`,
          errors: [{ messageId: "sdkImport", data: { name: "openai" } }],
        },
        // @anthropic-ai/sdk import.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `import Anthropic from "@anthropic-ai/sdk";`,
          errors: [
            { messageId: "sdkImport", data: { name: "@anthropic-ai/sdk" } },
          ],
        },
        // Dynamic SDK import.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `const m = await import("groq-sdk");`,
          errors: [{ messageId: "sdkImport", data: { name: "groq-sdk" } }],
        },
        // CJS require of an SDK package.
        {
          filename: "/repo/web/lib/ai/foo.cjs",
          code: `const x = require("@google/generative-ai");`,
          errors: [
            {
              messageId: "sdkImport",
              data: { name: "@google/generative-ai" },
            },
          ],
        },
        // Raw fetch to OpenAI's URL.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `fetch("https://api.openai.com/v1/chat/completions");`,
          errors: [{ messageId: "providerUrl" }],
        },
        // Raw fetch to Anthropic's URL.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `fetch("https://api.anthropic.com/v1/messages");`,
          errors: [{ messageId: "providerUrl" }],
        },
        // URL inside a template literal.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: "const u = `https://api.groq.com/openai/v1/${path}`;",
          errors: [{ messageId: "providerUrl" }],
        },
        // Gemini endpoint.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `fetch("https://generativelanguage.googleapis.com/v1beta/models");`,
          errors: [{ messageId: "providerUrl" }],
        },
        // Together AI endpoint outside the allowlist is forbidden.
        {
          filename: "/repo/web/lib/ai/foo.ts",
          code: `fetch("https://api.together.xyz/v1/chat/completions");`,
          errors: [{ messageId: "providerUrl" }],
        },
      ],
    });
  });
});
