/**
 * Fase 3 — phase boundary detector for the remediation loop.
 *
 * The loop starts in the "explore" phase (cheap reasoning model) and
 * transitions to "fix" (flagship model) once the agent has located the
 * bug. Per REMEDIATION_SYSTEM_ARCHITECTURE.md §4 Fase 3, the transition
 * fires on EITHER:
 *
 *   (a) the first `apply_patch` tool call — the agent committed to a fix
 *
 *   (b) an explicit `think` tool call whose thought declares a specific
 *       file path — the agent has finished exploration and knows where
 *       the bug is
 *
 * Detecting (a) is unambiguous. Detecting (b) is heuristic: we look for
 * a repo-relative file path with a source-code extension in the thought
 * text. We deliberately use a narrow regex to avoid false positives on
 * thoughts that merely mention a directory ("looking in src/") — the
 * extension requirement (`.ts`, `.js`, `.tsx`, etc.) is what anchors
 * detection to a concrete fix target.
 *
 * False negatives (the model says "I'll fix auth/middleware" without the
 * extension) are acceptable: the transition just happens one turn later
 * when `apply_patch` fires. The cost of a single extra explore-model
 * turn is trivial; the cost of a premature transition (burning gpt-5.4
 * on more exploration) is larger.
 */

import type { ContentBlock, ToolUseBlock } from "./ai-client.js";

// Match repo-relative paths with a source-code extension. Allow the common
// repo roots we see in the wild (src, app, lib, pages, web, worker,
// packages, server, api, components, utils) plus root-level files
// (package.json, tsconfig.json, etc. but only if they carry a code
// extension we care about for a fix).
const FIX_PATH_REGEX =
  /\b(?:[\w./-]+)?(?:src|app|lib|pages|web|worker|packages|server|api|components|utils|hooks|routes|modules|controllers|services|models|tests?|__tests__|e2e|scripts|config)\/[\w.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|rb|java|kt|swift|php|cs)\b/;

/**
 * Returns true when any tool_use block in the content marks the boundary
 * between explore and fix. Does NOT mutate; callers flip their own phase
 * flag on a truthy return.
 */
export function detectPhaseTransition(content: ContentBlock[]): boolean {
  for (const b of content) {
    if (b.type !== "tool_use") continue;
    const tu = b as ToolUseBlock;

    // Primary trigger: apply_patch.
    if (tu.name === "apply_patch") return true;

    // Secondary trigger: think with a concrete file path.
    if (tu.name === "think") {
      const thought = (tu.input as { thought?: unknown }).thought;
      if (typeof thought === "string" && FIX_PATH_REGEX.test(thought)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Exported for tests so they can assert the regex behavior directly
 * without constructing a full ToolUseBlock.
 */
export function thoughtDeclaresFilePath(thought: string): boolean {
  return FIX_PATH_REGEX.test(thought);
}
