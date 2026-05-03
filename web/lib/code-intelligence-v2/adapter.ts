/**
 * Code Intelligence v2 — result adapter.
 *
 * Maps v2 SemanticSearchResult → v1 CodeSearchResult so the existing
 * `searchCode()` consumers (MCP tools, remediate.ts, dashboard) keep their
 * call signatures unchanged when the flag flips.
 *
 * Important caveats — documented for callers that opt into v2:
 *
 *   - `code` is always empty string. v2 does not store source text on
 *     `code_symbols` (the column doesn't exist in migration 0079). The
 *     container agent has direct file-read tools so it doesn't need
 *     code text in retrieval results. Dashboard surfaces that DO need
 *     a snippet must read the file via GitHub API at render time.
 *
 *   - `chunkId` is the v2 `code_symbols.id`. It's still a stable UUID,
 *     just from a different table. Callers that round-trip the id (e.g.
 *     for fingerprinting) will keep working.
 *
 *   - `score` is a derived rank: 1.0 for the first result, decays
 *     1 / (1 + position). v2's primary ranking is by name length (handled
 *     in queries.ts) so the score order matches the array order.
 *
 *   - `chunkType` maps from v2's `kind` taxonomy to v1's `chunkType`. Any
 *     kind v1 didn't know (interface, enum, namespace) maps to "type" so
 *     consumers that switch on chunkType keep working.
 */

import type { SymbolKind } from "@inariwatch/code-intel-extractor-ts";
import type { CodeReference } from "@/lib/db/schema";

import type { CodeSearchResult } from "@/lib/code-intelligence/search";
import type { SemanticSearchResult as V2SearchResult } from "./queries";

const KIND_TO_CHUNK_TYPE: Record<SymbolKind, "function" | "class" | "method" | "module" | "type"> = {
  function: "function",
  class: "class",
  method: "method",
  type: "type",
  variable: "type", // v1 has no `variable` chunkType — fall back to `type`.
  interface: "type",
  enum: "type",
  namespace: "module",
};

export function adaptV2ToV1(results: V2SearchResult[]): CodeSearchResult[] {
  return results.map((r, idx) => {
    const sym = r.symbol;
    return {
      chunkId: sym.id,
      filePath: sym.filePath,
      name: sym.name,
      chunkType: KIND_TO_CHUNK_TYPE[sym.kind as SymbolKind] ?? "type",
      startLine: sym.startLine,
      endLine: sym.endLine,
      // Code text is not stored on v2 symbols. Document via doc comment when
      // present so dashboard surfaces have *something* to render.
      code: "",
      docstring: sym.docComment ?? null,
      language: sym.language,
      score: 1 / (1 + idx),
      callers: r.callers
        .filter((ref): ref is typeof ref & { sourceSymbolId: string } => !!ref.sourceSymbolId)
        .map((ref) => ({
          name: refDisplayName(ref),
          filePath: ref.filePath,
          code: "",
        })),
      callees: r.callees
        .map((ref) => ({
          name: refDisplayName(ref),
          filePath: ref.filePath,
          code: "",
        })),
    };
  });
}

function refDisplayName(ref: CodeReference): string {
  // We don't have the target's name in the reference row — surface the
  // file:line so the consumer can render something meaningful. Phase 3
  // may join through to symbols if a richer display is needed.
  return `${ref.filePath}:${ref.line}`;
}

// Helper for Phase 1.7 shadow logging — extract just the FQN list for
// divergence analysis. Caller passes the ranked v2 results (not adapted).
export function topFqns(results: V2SearchResult[], n = 10): string[] {
  return results.slice(0, n).map((r) => r.symbol.fqn);
}

export function topFqnsFromV1(results: CodeSearchResult[], n = 10): string[] {
  return results.slice(0, n).map((r) => `${r.filePath}::${r.name}`);
}
