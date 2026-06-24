/**
 * Inari Live pure-slash Phase 2 — frontend wrapper for the
 * `suggest_slash_commands` Tauri IPC.
 *
 * The dropdown calls `suggestSlashCommands(query)` whenever the user
 * types something that doesn't start with `/` (debounced by the
 * caller). We POST the query + canonical `SLASH_MANIFEST` to the
 * web `/api/ai/suggest-slash` endpoint via the Rust IPC at
 * `desktop/src-tauri/src/ipc/slash.rs`.
 *
 * Always resolves to `SlashSuggestion[]` — never throws. Empty array
 * is the universal "no command matches" signal (regardless of whether
 * the cause was AI confidence, offline cloud, missing bearer, or rate
 * limit). This keeps the UI logic atomic: render rows OR render the
 * "no command matches" line based on a single array length check.
 */

import { invoke } from "@tauri-apps/api/core";

import { SLASH_MANIFEST, type SlashCommand } from "./manifest";

/**
 * One AI-suggested command. Mirrors the Rust `SlashSuggestion` struct in
 * `desktop/src-tauri/src/ipc/slash.rs` and the web response type at
 * `web/app/api/ai/suggest-slash/route.ts`.
 */
export interface SlashSuggestion {
  /** Full command line, e.g. `"/projects --integration=capture"`. */
  command: string;
  /** 1-line natural-language rationale shown in the dropdown row. */
  rationale: string;
  /** 0..1. Used for UI ranking — frontend trusts server order. */
  confidence: number;
}

/**
 * Compact serialisation of the manifest sent over IPC. Drops
 * `examples` (UI hints) and `tone` (CSS), matching the cap budget
 * documented in `INARI_LIVE_PURE_SLASH_PLAN.md`.
 *
 * Exposed so the autocomplete tests can assert against the actual
 * payload shape that hits the IPC.
 */
export function manifestForSuggest(): SlashCommand[] {
  // Casting through `unknown` so we can mutate the readonly array's
  // entries while keeping the type compatible with the IPC contract.
  return SLASH_MANIFEST.map((entry) => ({
    name:        entry.name,
    description: entry.description,
    args:        entry.args.map((arg) => ({ ...arg })),
    handler:     entry.handler,
    examples:    [], // dropped — manifestForSuggest is shape-compatible
  }));
}

/**
 * Call `suggest_slash_commands` over Tauri IPC. Always resolves;
 * never rejects. The Rust side already swallows every failure mode
 * (offline, 401, 429, parse error) into `Ok(vec![])`, but we wrap a
 * defensive try/catch here so a missing-Tauri runtime in tests /
 * web preview doesn't surface as a console error.
 *
 * Phase 5.4 — optional `memoryContext` forwards the scoped-memory
 * ring buffer's formatted prompt context (last 3 outputs with
 * inline entity IDs + discriminators) to the web endpoint so the
 * LLM can resolve free-form references like "fixea la del payment".
 * Empty / undefined is fine — the wire payload skips the field.
 */
export interface SuggestOptions {
  memoryContext?: string;
}

export async function suggestSlashCommands(
  query: string,
  options: SuggestOptions = {},
): Promise<SlashSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const memory = options.memoryContext?.trim() || undefined;
  try {
    const result = await invoke<SlashSuggestion[]>("suggest_slash_commands", {
      query:         trimmed,
      manifest:      manifestForSuggest(),
      memoryContext: memory ?? null,
    });
    return Array.isArray(result) ? result : [];
  } catch {
    // IPC unavailable (Storybook / vitest / web preview) or runtime
    // error. The dropdown shows "no command matches" — same UX as a
    // legitimately empty server response.
    return [];
  }
}
