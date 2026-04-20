/**
 * apply_patch envelope parser + applier.
 *
 * Implements OpenAI Codex's `apply_patch` format — the exact syntax
 * GPT-5.3/5.4 was trained on for code edits. Documented in
 * https://github.com/openai/codex (see
 * `codex-rs/core/prompt_with_apply_patch_instructions.md`).
 *
 * Why a custom parser instead of OpenAI's built-in `apply_patch` tool:
 *   - The built-in tool is flagged unstable as of March 2026 (Azure
 *     reports + multiple Codex repo issues): it regresses when
 *     combined with custom tools.
 *   - We want full control over how hunks resolve (exact-match first,
 *     fuzzy whitespace normalization fallback) and over the error
 *     messages the agent sees.
 *   - Shipping our own keeps the entire fix path in the same code we
 *     can unit test, including on the Hetzner worker (which can't
 *     import from @/lib anyway).
 *
 * Format (minimal, what we support):
 *
 *   *** Begin Patch
 *   *** Update File: path/to/foo.ts
 *   @@
 *   -removed
 *   +added
 *    context line (leading space preserved)
 *   *** Add File: path/to/bar.ts
 *   +line one
 *   +line two
 *   *** Delete File: path/to/baz.ts
 *   *** End Patch
 *
 * Multiple @@ hunks per file are supported. Context lines start with
 * a single space. Removed lines start with "-". Added lines start
 * with "+". Hunk headers (@@...) can carry optional context after
 * the @@ which we use for disambiguation when the same -/+ block
 * appears more than once.
 *
 * Out of scope v1: renames (*** Move File:), binary files, patches
 * with mixed CRLF/LF line endings (we normalize to LF on read).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type HunkLine =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

export interface Hunk {
  /** Optional context string after @@ (disambiguates duplicate hunks). */
  header: string;
  lines: HunkLine[];
}

export type PatchOp =
  | { op: "update"; path: string; hunks: Hunk[] }
  | { op: "add"; path: string; body: string }
  | { op: "delete"; path: string };

export interface Patch {
  ops: PatchOp[];
}

export class ApplyPatchError extends Error {
  constructor(
    message: string,
    public readonly context?: { op?: string; path?: string; hunkIndex?: number },
  ) {
    super(message);
    this.name = "ApplyPatchError";
  }
}

// ── Parser ───────────────────────────────────────────────────────────────────

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
// Prefixes without trailing space — we strip the colon + optional space
// ourselves, so models that emit "*** Update File:" (no space, no path)
// hit the "empty path" error instead of the generic "unexpected line".
const UPDATE_PREFIX = "*** Update File:";
const ADD_PREFIX = "*** Add File:";
const DELETE_PREFIX = "*** Delete File:";
const HUNK_PREFIX = "@@";

/**
 * Parse a patch envelope string into structured ops. Normalizes line
 * endings to LF before parsing.
 *
 * Throws ApplyPatchError with useful context on malformed input.
 */
export function parsePatch(patch: string): Patch {
  const normalized = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  let i = 0;

  // Skip leading blank lines until we find Begin Patch.
  while (i < lines.length && lines[i].trim() === "") i++;

  if (lines[i] !== BEGIN) {
    throw new ApplyPatchError(`Patch must start with "${BEGIN}" — got "${lines[i] ?? "(empty)"}"`);
  }
  i++;

  const ops: PatchOp[] = [];

  while (i < lines.length) {
    const line = lines[i];

    if (line === END) {
      // Consume and finish — ignore trailing blank lines.
      return { ops };
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith(UPDATE_PREFIX)) {
      const path = line.slice(UPDATE_PREFIX.length).trim();
      if (!path) throw new ApplyPatchError("Update File header has empty path", { op: "update" });
      i++;
      const { hunks, nextIndex } = parseHunks(lines, i, path);
      ops.push({ op: "update", path, hunks });
      i = nextIndex;
      continue;
    }

    if (line.startsWith(ADD_PREFIX)) {
      const path = line.slice(ADD_PREFIX.length).trim();
      if (!path) throw new ApplyPatchError("Add File header has empty path", { op: "add" });
      i++;
      const { body, nextIndex } = parseAddBody(lines, i, path);
      ops.push({ op: "add", path, body });
      i = nextIndex;
      continue;
    }

    if (line.startsWith(DELETE_PREFIX)) {
      const path = line.slice(DELETE_PREFIX.length).trim();
      if (!path) throw new ApplyPatchError("Delete File header has empty path", { op: "delete" });
      ops.push({ op: "delete", path });
      i++;
      continue;
    }

    throw new ApplyPatchError(
      `Unexpected line inside patch at line ${i + 1}: "${line.slice(0, 120)}"`,
    );
  }

  // Reached end of input without an End Patch marker — tolerate it if we
  // parsed at least one op (some models omit the closing marker).
  if (ops.length === 0) {
    throw new ApplyPatchError(`Patch ended with no operations`);
  }
  return { ops };
}

function parseHunks(
  lines: string[],
  start: number,
  path: string,
): { hunks: Hunk[]; nextIndex: number } {
  const hunks: Hunk[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (line === END || line.startsWith(UPDATE_PREFIX) || line.startsWith(ADD_PREFIX) || line.startsWith(DELETE_PREFIX)) {
      break;
    }

    if (!line.startsWith(HUNK_PREFIX)) {
      // Blank lines between file header and first hunk are tolerated.
      if (line.trim() === "") {
        i++;
        continue;
      }
      throw new ApplyPatchError(
        `Expected hunk header "@@" after Update File, got "${line.slice(0, 120)}"`,
        { op: "update", path, hunkIndex: hunks.length },
      );
    }

    const header = line.slice(HUNK_PREFIX.length).trim();
    i++;

    const hunkLines: HunkLine[] = [];
    while (i < lines.length) {
      const bodyLine = lines[i];
      if (
        bodyLine === END ||
        bodyLine.startsWith(UPDATE_PREFIX) ||
        bodyLine.startsWith(ADD_PREFIX) ||
        bodyLine.startsWith(DELETE_PREFIX) ||
        bodyLine.startsWith(HUNK_PREFIX)
      ) {
        break;
      }

      if (bodyLine.startsWith("-")) {
        hunkLines.push({ kind: "remove", text: bodyLine.slice(1) });
      } else if (bodyLine.startsWith("+")) {
        hunkLines.push({ kind: "add", text: bodyLine.slice(1) });
      } else if (bodyLine.startsWith(" ")) {
        hunkLines.push({ kind: "context", text: bodyLine.slice(1) });
      } else if (bodyLine === "") {
        hunkLines.push({ kind: "context", text: "" });
      } else {
        throw new ApplyPatchError(
          `Hunk line must start with " ", "-", or "+" — got "${bodyLine.slice(0, 120)}"`,
          { op: "update", path, hunkIndex: hunks.length },
        );
      }
      i++;
    }

    if (hunkLines.length === 0) {
      throw new ApplyPatchError(`Hunk in ${path} has no body lines`, {
        op: "update",
        path,
        hunkIndex: hunks.length,
      });
    }

    hunks.push({ header, lines: hunkLines });
  }

  if (hunks.length === 0) {
    throw new ApplyPatchError(`Update File ${path} has no hunks`, { op: "update", path });
  }
  return { hunks, nextIndex: i };
}

function parseAddBody(
  lines: string[],
  start: number,
  path: string,
): { body: string; nextIndex: number } {
  const out: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (
      line === END ||
      line.startsWith(UPDATE_PREFIX) ||
      line.startsWith(ADD_PREFIX) ||
      line.startsWith(DELETE_PREFIX)
    ) {
      break;
    }
    // Add File body: every line starts with "+", identical to a no-context hunk.
    // Tolerate blank lines (some models emit them) and lines that are plain text
    // when the model forgets the "+" prefix — treat those as literal content.
    if (line.startsWith("+")) out.push(line.slice(1));
    else if (line === "") out.push("");
    else
      throw new ApplyPatchError(
        `Add File ${path}: every line must start with "+" — got "${line.slice(0, 120)}"`,
        { op: "add", path },
      );
    i++;
  }
  if (out.length === 0) {
    throw new ApplyPatchError(`Add File ${path} has no body`, { op: "add", path });
  }
  // Newer Codex models omit a trailing newline; don't auto-add one.
  return { body: out.join("\n"), nextIndex: i };
}

// ── Applier ──────────────────────────────────────────────────────────────────

export interface ApplyResult {
  /** Files that were created or modified, with their final contents. */
  changed: { path: string; content: string; op: "update" | "add" | "delete" }[];
}

/**
 * Apply a parsed patch to an in-memory file map. The caller supplies
 * `readFile(path) => string | null` (null when not found) and receives
 * a map of changed files they can persist. This keeps the applier
 * pure — the web-side caller can write to disk via the container API,
 * the worker-side caller can write to a local checkout, tests can
 * run entirely in memory.
 */
export async function applyPatch(
  patch: Patch,
  readFile: (path: string) => Promise<string | null>,
): Promise<ApplyResult> {
  const changed: ApplyResult["changed"] = [];

  for (const op of patch.ops) {
    if (op.op === "delete") {
      changed.push({ path: op.path, content: "", op: "delete" });
      continue;
    }

    if (op.op === "add") {
      // Guard against overwriting existing files — "Add File" must mean new.
      const existing = await readFile(op.path);
      if (existing !== null) {
        throw new ApplyPatchError(
          `Add File ${op.path}: path already exists. Use "*** Update File:" instead.`,
          { op: "add", path: op.path },
        );
      }
      changed.push({ path: op.path, content: op.body, op: "add" });
      continue;
    }

    // op.op === "update"
    const current = await readFile(op.path);
    if (current === null) {
      throw new ApplyPatchError(
        `Update File ${op.path}: file not found. Use "*** Add File:" to create it.`,
        { op: "update", path: op.path },
      );
    }

    let working = current;
    for (let h = 0; h < op.hunks.length; h++) {
      const hunk = op.hunks[h];
      working = applyHunk(working, hunk, op.path, h);
    }
    changed.push({ path: op.path, content: working, op: "update" });
  }

  return { changed };
}

/**
 * Apply one hunk to a file.
 *
 * We try to locate the hunk in three increasingly tolerant passes:
 *
 *   1. Full-block exact match  — search block = context + remove lines,
 *      byte-for-byte match in the file. Strictest but cheapest.
 *   2. Full-block loose match  — same search block, whitespace-tolerant
 *      (trailing whitespace on blank lines + tab→4-space). Catches the
 *      common "model drops a trailing space" case.
 *   3. Remove-only loose match — search for just the `-` lines as a
 *      consecutive run (ignoring leading whitespace entirely). Real-world
 *      unified-diff patches from reasoning models drift on indentation
 *      and context line count. As long as the lines to REMOVE appear
 *      consecutively somewhere, we can still apply the hunk. Context
 *      lines are then used ONLY to disambiguate when the same remove
 *      block appears more than once.
 *
 * When the hunk has only add lines (pure insertion), we require at least
 * one context line as an anchor — otherwise there's no way to know where
 * the insertion belongs.
 */
function applyHunk(content: string, hunk: Hunk, path: string, hunkIndex: number): string {
  const fileLines = content.split("\n");

  const searchLines: string[] = []; // context + remove in order (block to find)
  const replaceLines: string[] = []; // context + add in order (block to insert)
  const removeLines: string[] = []; // just remove lines (for fallback match)
  const contextLines: string[] = []; // just context lines (for disambiguation)
  for (const line of hunk.lines) {
    if (line.kind === "context") {
      searchLines.push(line.text);
      replaceLines.push(line.text);
      contextLines.push(line.text);
    } else if (line.kind === "remove") {
      searchLines.push(line.text);
      removeLines.push(line.text);
    } else {
      replaceLines.push(line.text);
    }
  }

  if (searchLines.length === 0) {
    // Pure-add hunk at the end of file (unusual but valid for append patterns).
    return content + (content.endsWith("\n") ? "" : "\n") + replaceLines.join("\n");
  }

  // Pass 1: exact full-block match.
  let matchIndex = findBlock(fileLines, searchLines);
  let matchLength = searchLines.length;

  // Pass 2: loose full-block match (whitespace-tolerant).
  if (matchIndex < 0) {
    matchIndex = findBlockLoose(fileLines, searchLines);
    matchLength = searchLines.length;
  }

  // Pass 3: remove-only match — find just the "-" lines as a consecutive
  // sequence. This handles unified-diff patches where context drifts
  // (model got indentation or a nearby line slightly wrong).
  if (matchIndex < 0 && removeLines.length > 0) {
    const removeIdx = findBlockLoose(fileLines, removeLines);
    if (removeIdx >= 0) {
      // If context lines surround the remove block in the hunk, verify at
      // least one of the adjacent file lines matches a context line to
      // avoid applying the patch at the wrong location when the same
      // remove block exists twice.
      const leadingCtx = contextLinesBeforeRemoveBlock(hunk);
      const trailingCtx = contextLinesAfterRemoveBlock(hunk);
      const fileAbove = removeIdx > 0 ? fileLines[removeIdx - 1] : "";
      const fileBelow =
        removeIdx + removeLines.length < fileLines.length
          ? fileLines[removeIdx + removeLines.length]
          : "";
      const leadingOk =
        leadingCtx.length === 0 || leadingCtx.some((c) => normalizeLoose(c) === normalizeLoose(fileAbove));
      const trailingOk =
        trailingCtx.length === 0 || trailingCtx.some((c) => normalizeLoose(c) === normalizeLoose(fileBelow));

      if (leadingOk && trailingOk) {
        // Replace ONLY the remove block with the add lines — preserve
        // whatever surrounding context the file actually has.
        const addLines = hunk.lines.filter((l) => l.kind === "add").map((l) => l.text);
        const before = fileLines.slice(0, removeIdx);
        const after = fileLines.slice(removeIdx + removeLines.length);
        return [...before, ...addLines, ...after].join("\n");
      }
    }
  }

  if (matchIndex < 0) {
    const preview = searchLines.slice(0, 5).map((l) => `  | ${l}`).join("\n");
    const removePreview =
      removeLines.length > 0
        ? `\n\nOr the lines to remove:\n${removeLines.slice(0, 3).map((l) => `  - ${l}`).join("\n")}`
        : "";
    const hint =
      hunk.header.length > 0
        ? `\nHeader context: ${hunk.header}`
        : `\n(No header context; add one after @@ to disambiguate.)`;
    throw new ApplyPatchError(
      `Hunk ${hunkIndex + 1} in ${path} did not match file contents.${hint}\nExpected to find:\n${preview}${
        searchLines.length > 5 ? `\n  | ... (${searchLines.length - 5} more lines)` : ""
      }${removePreview}\n\nTry re-reading the file and emitting a fresh patch with the exact current content as context. If the edit is a pure insertion, keep 1-2 surrounding context lines above and below the + lines.`,
      { op: "update", path, hunkIndex },
    );
  }

  const before = fileLines.slice(0, matchIndex);
  const after = fileLines.slice(matchIndex + matchLength);
  return [...before, ...replaceLines, ...after].join("\n");
}

/** Extract the context lines that precede the first remove/add line. */
function contextLinesBeforeRemoveBlock(hunk: Hunk): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === "context") out.push(line.text);
    else break;
  }
  return out;
}

/** Extract the context lines that follow the last remove/add line. */
function contextLinesAfterRemoveBlock(hunk: Hunk): string[] {
  const out: string[] = [];
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    const line = hunk.lines[i];
    if (line.kind === "context") out.unshift(line.text);
    else break;
  }
  return out;
}

function findBlock(lines: string[], block: string[]): number {
  if (block.length === 0) return -1;
  outer: for (let i = 0; i <= lines.length - block.length; i++) {
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Loose match — normalizes trailing whitespace, tabs-to-spaces, and
 * collapses leading whitespace runs (so "  const x" matches "    const x"
 * when the model got indentation wrong).
 */
function normalizeLoose(s: string): string {
  return s.replace(/\s+$/, "").replace(/\t/g, "    ").replace(/^\s+/, "");
}

function findBlockLoose(lines: string[], block: string[]): number {
  const normalizedBlock = block.map(normalizeLoose);
  outer: for (let i = 0; i <= lines.length - block.length; i++) {
    for (let j = 0; j < block.length; j++) {
      if (normalizeLoose(lines[i + j]) !== normalizedBlock[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ── Convenience: one-shot parse + apply ─────────────────────────────────────

export async function parseAndApply(
  patchText: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<ApplyResult> {
  const patch = parsePatch(patchText);
  return applyPatch(patch, readFile);
}
