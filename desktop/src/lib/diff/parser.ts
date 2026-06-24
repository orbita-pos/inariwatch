/**
 * Unified-diff parser. The minimum subset of `diff -U` output the dock
 * needs to render Mode 4 — multi-hunk per-file, line-level (`+` / `-` /
 * context), and binary-detection sentinel.
 *
 * Out of scope:
 *   - Multi-file diffs. Sesión 16 surfaces ONE file per Mode-4 view —
 *     `Fix.diff` is per-file already. If we eventually surface multi-
 *     file fixes the parser splits at `diff --git` boundaries; trivial
 *     to add but not needed now.
 *   - "No newline at end of file" markers. The parser silently absorbs
 *     them — they don't influence how the line is rendered.
 *   - Word-level diff (intra-line +/- highlighting). Ships in a later
 *     iteration; the line-level model is already enough for the money
 *     shot.
 *
 * The parser is deliberately permissive: malformed input degrades to
 * an empty `hunks` array rather than throwing, so a corrupted Fix
 * payload renders as an empty-diff badge instead of crashing the dock.
 */

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Raw content of the line, leading `+`/`-`/` ` stripped. */
  content: string;
  /** 1-based line number in the OLD file, or null for `add` lines. */
  oldLineNo: number | null;
  /** 1-based line number in the NEW file, or null for `del` lines. */
  newLineNo: number | null;
}

export interface DiffHunk {
  /** Starting line in the old file (1-based, from `@@ -A,B +C,D @@`). */
  oldStart: number;
  /** Old-side line count from the hunk header. */
  oldLines: number;
  /** Starting line in the new file (1-based). */
  newStart: number;
  /** New-side line count from the hunk header. */
  newLines: number;
  /** Optional section heading carried after `@@` in the header. */
  heading: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** True when the input is the `Binary files differ` sentinel. */
  binary: boolean;
}

const HUNK_HEADER_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const BINARY_RE = /^Binary files .* differ$/m;

export function parseUnifiedDiff(input: string): ParsedDiff {
  if (!input) return { hunks: [], binary: false };
  if (BINARY_RE.test(input)) return { hunks: [], binary: true };

  const lines = input.split(/\r?\n/);
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const headerMatch = HUNK_HEADER_RE.exec(line);

    if (headerMatch) {
      const oldStart = parseInt(headerMatch[1] ?? "0", 10);
      const oldLines = parseInt(headerMatch[2] ?? "1", 10);
      const newStart = parseInt(headerMatch[3] ?? "0", 10);
      const newLines = parseInt(headerMatch[4] ?? "1", 10);
      const heading = (headerMatch[5] ?? "").trim();
      current = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        heading,
        lines: [],
      };
      oldCursor = oldStart;
      newCursor = newStart;
      hunks.push(current);
      continue;
    }

    if (!current) {
      // Pre-hunk preamble (file headers, `diff --git`, `---`/`+++`,
      // etc.) — ignore until we hit the first `@@` line.
      continue;
    }

    // Sentinel for `\ No newline at end of file` — silently skip; the
    // surrounding +/-/context line was already pushed.
    if (line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      current.lines.push({
        type: "add",
        content: line.slice(1),
        oldLineNo: null,
        newLineNo: newCursor,
      });
      newCursor += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({
        type: "del",
        content: line.slice(1),
        oldLineNo: oldCursor,
        newLineNo: null,
      });
      oldCursor += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({
        type: "context",
        content: line.slice(1),
        oldLineNo: oldCursor,
        newLineNo: newCursor,
      });
      oldCursor += 1;
      newCursor += 1;
    } else if (line === "") {
      // Treat fully blank lines as context with an empty payload —
      // diff producers occasionally drop the leading space.
      current.lines.push({
        type: "context",
        content: "",
        oldLineNo: oldCursor,
        newLineNo: newCursor,
      });
      oldCursor += 1;
      newCursor += 1;
    }
    // Anything else (e.g. trailing junk after the last hunk) is ignored.
  }

  return { hunks, binary: false };
}
