// Stable hash of a symbol's source text. Used by the Phase 1.3 indexer for
// incremental skip-when-unchanged.
//
// Normalization rules — same as the TS extractor:
//   - Strip Python comments (# ...) and docstrings (we leave docstrings out
//     because reformatting one shouldn't invalidate the symbol).
//   - Collapse whitespace runs to a single space.
//   - Prepend a kind tag so a function and a variable with identical text
//     hash differently.

import { createHash } from "node:crypto";

const HASH_LINE_COMMENT_RE = /#.*$/gm;
// Match triple-quoted string literals ("""..."""  /  '''...''').
const HASH_TRIPLE_STRING_RE = /(?:"""[\s\S]*?"""|'''[\s\S]*?''')/g;
const HASH_WS_RE = /\s+/g;

export function astHash(kindTag: string, text: string): string {
  const normalized = text
    .replace(HASH_TRIPLE_STRING_RE, " ")
    .replace(HASH_LINE_COMMENT_RE, " ")
    .replace(HASH_WS_RE, " ")
    .trim();
  return createHash("sha256")
    .update(`${kindTag} ${normalized}`, "utf8")
    .digest("hex");
}
