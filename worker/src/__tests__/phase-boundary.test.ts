/**
 * Fase 3 — phase-boundary detector tests.
 *
 * We care about three things:
 *   1. apply_patch ALWAYS triggers the transition (primary signal).
 *   2. think-with-file-path triggers (secondary signal), with a narrow
 *      enough regex that generic "looking at src/" thoughts don't trip it.
 *   3. pure exploration (read_file / search_code / list_directory) does
 *      NOT trigger — otherwise the loop would flip to the expensive model
 *      before the agent has a fix target.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPhaseTransition, thoughtDeclaresFilePath } from "../phase-boundary.js";
import type { ContentBlock, ToolUseBlock } from "../ai-client.js";

function tu(name: string, input: Record<string, unknown>, id = "call_test"): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

describe("detectPhaseTransition — apply_patch (primary)", () => {
  it("transitions on apply_patch even with empty patch input", () => {
    const content: ContentBlock[] = [tu("apply_patch", { patch: "" })];
    assert.equal(detectPhaseTransition(content), true);
  });

  it("transitions on apply_patch with a real patch envelope", () => {
    const content: ContentBlock[] = [
      tu("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch" }),
    ];
    assert.equal(detectPhaseTransition(content), true);
  });

  it("transitions when apply_patch appears alongside other tools", () => {
    const content: ContentBlock[] = [
      tu("read_file", { path: "src/a.ts" }, "c1"),
      tu("apply_patch", { patch: "x" }, "c2"),
    ];
    assert.equal(detectPhaseTransition(content), true);
  });
});

describe("detectPhaseTransition — think with file path (secondary)", () => {
  it("transitions when thought declares a .ts path under src/", () => {
    const content: ContentBlock[] = [
      tu("think", { thought: "The bug is in src/auth/middleware.ts — missing null check." }),
    ];
    assert.equal(detectPhaseTransition(content), true);
  });

  it("transitions on a lib/ path with .js extension", () => {
    const content: ContentBlock[] = [
      tu("think", { thought: "Fix needed in lib/session/refresh.js at line 42." }),
    ];
    assert.equal(detectPhaseTransition(content), true);
  });

  it("transitions on a worker/src path with .ts extension", () => {
    const content: ContentBlock[] = [
      tu("think", { thought: "Patching worker/src/container-agent.ts to add phase state." }),
    ];
    assert.equal(detectPhaseTransition(content), true);
  });

  it("transitions on a test file under __tests__", () => {
    const content: ContentBlock[] = [
      tu("think", { thought: "Assertion error originates in src/__tests__/foo.test.ts." }),
    ];
    assert.equal(detectPhaseTransition(content), true);
  });
});

describe("detectPhaseTransition — must NOT over-trigger", () => {
  it("does not transition on read_file alone", () => {
    const content: ContentBlock[] = [tu("read_file", { path: "src/auth/middleware.ts" })];
    assert.equal(detectPhaseTransition(content), false);
  });

  it("does not transition on search_code", () => {
    const content: ContentBlock[] = [tu("search_code", { query: "getUser(" })];
    assert.equal(detectPhaseTransition(content), false);
  });

  it("does not transition on list_directory", () => {
    const content: ContentBlock[] = [tu("list_directory", { prefix: "src/" })];
    assert.equal(detectPhaseTransition(content), false);
  });

  it("does not transition on think with directory-only mention (no extension)", () => {
    // "looking in src/" is exploration, not a fix target.
    const content: ContentBlock[] = [
      tu("think", { thought: "Let me look in src/auth/ to understand the flow." }),
    ];
    assert.equal(detectPhaseTransition(content), false);
  });

  it("does not transition on generic think without any path", () => {
    const content: ContentBlock[] = [
      tu("think", { thought: "I should probably grep for the symbol first." }),
    ];
    assert.equal(detectPhaseTransition(content), false);
  });

  it("does not transition on think with a URL that contains 'src/'", () => {
    // A URL to GitHub source view is NOT a fix declaration.
    const content: ContentBlock[] = [
      tu("think", { thought: "See https://github.com/org/repo/blob/main/README.md" }),
    ];
    assert.equal(detectPhaseTransition(content), false);
  });

  it("does not transition on non-tool-use content (text blocks only)", () => {
    const content: ContentBlock[] = [{ type: "text", text: "Thinking out loud about src/foo.ts" }];
    assert.equal(detectPhaseTransition(content), false);
  });
});

describe("thoughtDeclaresFilePath — regex direct tests", () => {
  it("accepts common repo roots with common extensions", () => {
    assert.equal(thoughtDeclaresFilePath("bug in src/foo.ts"), true);
    assert.equal(thoughtDeclaresFilePath("fix app/page.tsx"), true);
    assert.equal(thoughtDeclaresFilePath("packages/db/schema.ts needs update"), true);
    assert.equal(thoughtDeclaresFilePath("server/routes/user.js line 10"), true);
    assert.equal(thoughtDeclaresFilePath("scripts/seed-demo.ts"), true);
  });

  it("rejects paths without a code extension", () => {
    assert.equal(thoughtDeclaresFilePath("src/auth/"), false);
    assert.equal(thoughtDeclaresFilePath("lib/session"), false);
  });

  it("rejects extensions on unrelated roots", () => {
    // `random/dir/file.ts` — we only match on a whitelist of repo roots.
    assert.equal(thoughtDeclaresFilePath("random/dir/file.ts"), false);
  });
});
