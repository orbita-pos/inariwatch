/**
 * Expand "lazy write" markers in AI-generated fix output.
 *
 * The AI uses "// ... keep existing code ..." (or Python/HTML equivalents) to
 * skip unchanged sections. This function reconstitutes the full file by
 * merging the AI output with the original file content.
 *
 * Inspired by Lovable's "// ... keep existing code" pattern — reduces output
 * tokens by 60-80% for large files where only a few lines change.
 */

export const KEEP_MARKER_RE = /^\s*(?:\/\/|#|\/\*|\{\/\*)\s*\.\.\.\s*keep existing code\s*\.\.\.?\s*(?:\*\/|\*\/\})?$/i;

export class LazyWriteExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LazyWriteExpansionError";
  }
}

/**
 * Expand lazy-write markers against the original file content.
 *
 * Algorithm:
 * 1. Split both original and AI output into lines.
 * 2. Walk through AI output lines.
 * 3. When a marker is found, find the anchor lines (the line before and after
 *    the marker in the AI output) in the original file.
 * 4. Fill in the gap from the original.
 *
 * If no markers are found, returns the content as-is (backward compatible with
 * the "complete file" format).
 *
 * Throws LazyWriteExpansionError if an anchor line cannot be found in the
 * original — the caller should fall back to the raw AI content.
 */
export function expandLazyWrites(
  aiContent: string,
  originalContent: string,
): string {
  const aiLines = aiContent.split("\n");

  if (!aiLines.some((line) => KEEP_MARKER_RE.test(line))) {
    return aiContent;
  }

  const origLines = originalContent.split("\n");
  const result: string[] = [];
  let origCursor = 0;

  for (let i = 0; i < aiLines.length; i++) {
    if (!KEEP_MARKER_RE.test(aiLines[i])) {
      result.push(aiLines[i]);
      continue;
    }

    const anchorBefore = i > 0 ? aiLines[i - 1] : null;
    const anchorAfter = findNextNonMarkerLine(aiLines, i + 1);

    // Find where the anchor-before is in the original
    let startFill = 0;
    if (anchorBefore !== null) {
      const anchorIdx = findLineInOriginal(origLines, anchorBefore.trimEnd(), origCursor);
      if (anchorIdx >= 0) {
        startFill = anchorIdx + 1;
      } else {
        throw new LazyWriteExpansionError(
          `Anchor before marker not found in original: "${anchorBefore.trim()}"`,
        );
      }
    }

    // Find where the anchor-after is in the original
    let endFill = origLines.length;
    if (anchorAfter !== null) {
      const anchorIdx = findLineInOriginal(origLines, anchorAfter.trimEnd(), startFill);
      if (anchorIdx >= 0) {
        endFill = anchorIdx;
      } else {
        throw new LazyWriteExpansionError(
          `Anchor after marker not found in original: "${anchorAfter.trim()}"`,
        );
      }
    }

    for (let j = startFill; j < endFill; j++) {
      result.push(origLines[j]);
    }
    origCursor = endFill;
  }

  return result.join("\n");
}

function findNextNonMarkerLine(lines: string[], startIdx: number): string | null {
  for (let i = startIdx; i < lines.length; i++) {
    if (!KEEP_MARKER_RE.test(lines[i])) {
      return lines[i];
    }
  }
  return null;
}

function findLineInOriginal(
  origLines: string[],
  target: string,
  startFrom: number,
): number {
  const trimmedTarget = target.trimEnd();
  for (let i = startFrom; i < origLines.length; i++) {
    if (origLines[i].trimEnd() === trimmedTarget) {
      return i;
    }
  }
  // Fallback: search from beginning (anchor might be above cursor)
  for (let i = 0; i < startFrom; i++) {
    if (origLines[i].trimEnd() === trimmedTarget) {
      return i;
    }
  }
  return -1;
}

/**
 * Expand lazy writes for an array of fix files, given a map of original file contents.
 * Files without markers or without originals are passed through unchanged.
 * If expansion fails for a file, falls back to the raw AI content (may be
 * incomplete but won't silently corrupt).
 */
export function expandFixFiles(
  fixFiles: { path: string; content: string }[],
  originals: Map<string, string>,
): { path: string; content: string }[] {
  return fixFiles.map((f) => {
    const original = originals.get(f.path);
    if (!original) return f;
    try {
      return { path: f.path, content: expandLazyWrites(f.content, original) };
    } catch (err) {
      if (err instanceof LazyWriteExpansionError) {
        // Anchor mismatch — fall back to raw AI content rather than corrupt the file.
        // The raw content will have markers in it, but that's better than wrong code.
        return f;
      }
      throw err;
    }
  });
}
