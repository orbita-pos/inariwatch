/**
 * S7 — Stacktrace location parser.
 *
 * Pure TypeScript, zero runtime deps. Recognises four formats so
 * Inari can mount its hover-tooltip + right-click menu over each
 * `file:line[:col]` in alert / chat text:
 *
 * 1. Node V8 — `at <fn> (<path>:<line>:<col>)`
 * 2. Linter / rustc / tsc — `<path>:<line>:<col>` or `<path>:<line>`
 * 3. Python — `File "<path>", line <line>`
 * 4. Generic source path — `<path>:<line>` where `<path>` ends in a
 *    known source extension (so `1.0:0` in prose doesn't false-match).
 *
 * Parser is split into `parseStacktraceLines` (everything; used by
 * the chat surface to wrap matches with `<StacktraceContextMenu>`)
 * and `firstLocation` (used by the tray Rust side via the IPC echo
 * — but mirrored here so the same matcher runs in both surfaces).
 */

export interface StacktraceLocation {
  /** File path as it appeared in the matched text. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column when the match captured one. */
  col?: number;
  /** Function name when the V8 frame carried one. */
  fn?: string;
  /** Inclusive character index where the match starts in the input. */
  start: number;
  /** Exclusive character index where the match ends. */
  end: number;
  /** Raw substring captured — the chat surface uses this as the
   * tooltip label. */
  raw: string;
}

export interface ParsedStacktrace {
  /** Every line of the original input, preserved for the renderer. */
  raw: string[];
  /** Every location found, in source order, with its `start`/`end`
   * offsets relative to the joined input. */
  matches: StacktraceLocation[];
}

/**
 * Recognised source-file extensions for the generic / linter pattern.
 * Anchored to common ones across web + systems languages so the
 * parser stays useful on most stacktraces the alert pipeline
 * surfaces today (Node + Python + Rust + Go are the four heaviest
 * users in the InariWatch corpus). Extending this list is safe — a
 * new extension only ADDS matches, never removes.
 */
const SOURCE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "py",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "sql",
  "md",
  "json",
  "yml",
  "yaml",
  "toml",
];

const EXT_GROUP = SOURCE_EXTENSIONS.join("|");

/** `at <fn> (<path>:<line>:<col>)` — V8 / Node style. */
const NODE_V8 = new RegExp(
  String.raw`at\s+([^\s(]+)\s+\(([^:()]+):(\d+):(\d+)\)`,
  "g",
);

/** `File "<path>", line <line>` — Python traceback. */
const PYTHON = new RegExp(
  String.raw`File\s+"([^"]+)",\s+line\s+(\d+)`,
  "g",
);

/**
 * `<path>:<line>[:<col>]` — linter / rustc / tsc / generic.
 *
 * Path constraints to avoid false positives:
 * - Must contain a slash or backslash, OR start with `./`, OR be a
 *   Windows drive (`C:\…`).
 * - Must end in one of [`SOURCE_EXTENSIONS`].
 *
 * Two alternatives: Windows drive paths and Unix / dotted relative
 * paths. The two are joined with `|` and the line/col is captured
 * from after the path.
 */
const GENERIC = new RegExp(
  String.raw`(` +
    // Windows: C:\Users\jesus\foo\bar.ts
    String.raw`[A-Za-z]:[\\/][^\s:()]+\.(?:${EXT_GROUP})` +
    String.raw`|` +
    // Unix / relative: /srv/app/x.rs, ./src/lib/foo.ts, src/main.py
    String.raw`(?:\.{1,2}[\\/]|[\\/])?[^\s:()]*?[\\/][^\s:()]*?\.(?:${EXT_GROUP})` +
    String.raw`):(\d+)(?::(\d+))?`,
  "g",
);

/**
 * Parse `text` and return every recognised location with its
 * character offsets.
 *
 * Order is left-to-right by `start`. When two patterns match the same
 * substring we prefer the earlier-defined pattern (Node V8 → Python
 * → generic), reflecting their specificity ordering.
 */
export function parseStacktraceLines(text: string): ParsedStacktrace {
  const matches: StacktraceLocation[] = [];
  const seen = new Set<string>(); // dedupe overlapping captures

  // Node V8 frames first — most specific.
  for (const m of text.matchAll(NODE_V8)) {
    const fnName = m[1];
    const path = m[2];
    const line = Number(m[3]);
    const col = Number(m[4]);
    if (!path || !Number.isFinite(line)) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const key = `${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      file: path,
      line,
      col,
      fn: fnName,
      start,
      end,
      raw: m[0],
    });
  }

  // Python frames next.
  for (const m of text.matchAll(PYTHON)) {
    const path = m[1];
    const line = Number(m[2]);
    if (!path || !Number.isFinite(line)) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const key = `${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      file: path,
      line,
      start,
      end,
      raw: m[0],
    });
  }

  // Generic last — only count matches that don't overlap a previous
  // (more specific) match.
  for (const m of text.matchAll(GENERIC)) {
    const path = m[1];
    const line = Number(m[2]);
    const colRaw = m[3];
    if (!path || !Number.isFinite(line)) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(matches, start, end)) continue;
    matches.push({
      file: path,
      line,
      col: colRaw === undefined ? undefined : Number(colRaw),
      start,
      end,
      raw: m[0],
    });
  }

  matches.sort((a, b) => a.start - b.start);

  return {
    raw: text.split("\n"),
    matches,
  };
}

/** True iff `[start, end)` overlaps any existing match's range. */
function overlaps(
  existing: StacktraceLocation[],
  start: number,
  end: number,
): boolean {
  for (const m of existing) {
    if (start < m.end && m.start < end) return true;
  }
  return false;
}

/**
 * Convenience: first match in `text`, or `null` if no recognisable
 * location appears. Mirror of the Rust `notifications::first_location`
 * used by the tray "Open Latest Stacktrace in Editor" item.
 */
export function firstLocation(text: string): StacktraceLocation | null {
  const { matches } = parseStacktraceLines(text);
  return matches[0] ?? null;
}

/**
 * Split `text` into renderable segments — alternating plain prose and
 * stacktrace locations — so `<ChatMessage>` can wrap each location
 * with `<StacktraceContextMenu>` + `<StacktraceTooltip>` without
 * touching the prose.
 */
export interface ProseSegment {
  kind: "text";
  text: string;
}
export interface LocationSegment {
  kind: "location";
  location: StacktraceLocation;
}
export type StacktraceSegment = ProseSegment | LocationSegment;

export function segmentByLocations(text: string): StacktraceSegment[] {
  const { matches } = parseStacktraceLines(text);
  if (matches.length === 0) {
    return text.length > 0 ? [{ kind: "text", text }] : [];
  }

  const segments: StacktraceSegment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, m.start) });
    }
    segments.push({ kind: "location", location: m });
    cursor = m.end;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}
