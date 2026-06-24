/**
 * Friendly-error helpers — produce "did you mean…" suggestions when
 * the user types a slash command that the dispatcher couldn't find.
 *
 * Phase 4.4 of the pure-slash refactor (2026-05-15). The autocomplete
 * dropdown already steers the user toward valid commands during
 * typing, so this surface only fires after they've actually submitted
 * something the dispatcher can't resolve. Three sources of help:
 *
 *   1. **Unknown slash command** (`/foo`) — Levenshtein over manifest
 *      names. If the closest entry is within `THRESHOLD` edits, surface
 *      it: "Unknown command `/foo`. Did you mean `/<closest>`?"
 *   2. **AI no-suggestion** — already handled by SlashAutocomplete's
 *      "No command matches. Type `/help` to see what's available." row
 *      added in Phase 2. Re-exported here so the wording lives in one
 *      place if future iterations want to localize / A/B test it.
 *   3. **Command failure with a path-shaped error** — deferred to a
 *      v2 (requires a parent-dir-listing IPC we don't have yet). The
 *      brief lists `/install D:/wbe → "did you mean D:/web?"` as a
 *      future enhancement; documented in
 *      `INARI_LIVE_PURE_SLASH_PLAN.md` so a later pass picks it up
 *      without re-deriving the design.
 *
 * Levenshtein here is the textbook DP implementation. The manifest is
 * small (~40 names), names are short (~10 chars), so the O(m·n) cost
 * is negligible — running once per submitted unknown command.
 */

import { SLASH_MANIFEST } from "./manifest";

/**
 * Compute the Levenshtein edit distance between two strings (number of
 * single-character insertions / deletions / substitutions needed to
 * transform `a` into `b`). Symmetric — `levenshtein(a, b) === levenshtein(b, a)`.
 *
 * Exported so a future "fuzzy match over arbitrary corpus" (e.g.
 * `/<typo>` against a list of project slugs) can reuse the same
 * primitive without re-importing a library.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Single rolling row keeps the allocation tight — we never need the
  // full m×n matrix, just the previous row + the current cell.
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr: number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost,     // substitution
      );
    }
    // Swap prev/curr without re-allocating. Copy because curr's slots
    // are reused on the next iteration's writes.
    prev = curr.slice();
  }
  return prev[b.length];
}

/**
 * Edit-distance threshold below which a suggestion is considered close
 * enough to surface. 3 covers single typos (`alrts` → `alerts`,
 * distance 1), transpositions (`projetcs` → `projects`, distance 2),
 * and short adjacent-key fat-fingers (`instll` → `install`, distance
 * 1). Strings whose closest manifest entry exceeds this threshold
 * usually weren't typos — surfacing a "did you mean" there is more
 * misleading than helpful, so we fall through to a generic error.
 */
export const DID_YOU_MEAN_THRESHOLD = 3;

/**
 * Find the manifest command whose name (sans leading slash) is closest
 * in edit distance to `typed`. Returns `null` when the typed string is
 * empty OR when the closest entry exceeds `DID_YOU_MEAN_THRESHOLD`.
 *
 * The typed string is compared case-insensitively and SHOULD NOT
 * include the leading slash — caller is responsible for stripping it.
 */
export function closestCommandName(typed: string): string | null {
  const needle = typed.toLowerCase().trim();
  if (!needle) return null;

  let best: string | null = null;
  let bestDist = Infinity;
  for (const entry of SLASH_MANIFEST) {
    // Manifest names include the leading slash; compare against the
    // slug only so a typo'd `/projetcs` matches `/projects`'s `projects`.
    const cmd = entry.name.toLowerCase().slice(1);
    const d = levenshtein(needle, cmd);
    if (d < bestDist) {
      bestDist = d;
      best = entry.name;
    }
    if (bestDist === 0) break; // exact match — no better candidate possible
  }
  if (best === null) return null;
  return bestDist <= DID_YOU_MEAN_THRESHOLD ? best : null;
}

/**
 * Build the user-facing message for a typed-but-unknown slash command.
 * Composes the "did you mean" hint when the Levenshtein walk surfaces
 * a close candidate, falls back to the generic "Type `/help`" line
 * otherwise. Pure function — exported so tests can pin the exact
 * wording without spinning up the dispatcher.
 */
export function formatUnknownCommand(typed: string): string {
  const suggestion = closestCommandName(typed);
  if (suggestion) {
    return `Unknown command \`/${typed}\`. Did you mean \`${suggestion}\`? Type \`/help\` to see the full list.`;
  }
  return `Unknown command \`/${typed}\`. Type \`/help\` to see the full list.`;
}
