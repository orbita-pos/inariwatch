/**
 * Per-session retry memory for apply_patch failures.
 *
 * During one agentic remediation loop, when the model's apply_patch
 * attempt fails, we capture a compact fingerprint of WHAT was tried
 * and WHY it failed. On the next apply_patch failure, the tool_result
 * message fed back to the model includes a "DO NOT REPEAT" block that
 * lists prior fingerprints with their failure reasons.
 *
 * This prevents the common pathology we saw in PR #4 E2E: the model
 * emits roughly the same patch 3-5 times in a row, each time differing
 * by a line number or a single whitespace, and each time failing for
 * the same reason. The parser's error message on its own is not enough —
 * without visibility into previous attempts, the model has no way to
 * know it's repeating itself.
 *
 * Memory lives only for the duration of one agentic loop. It is NOT
 * persisted across sessions (would bloat the DB for little marginal
 * gain) and NOT shared across projects.
 *
 * Design constraint: the hint block must be short. LLM context is
 * expensive and the cheap model (gpt-4o-mini) is sensitive to noise.
 * We cap at 3 prior attempts in the hint and keep each one under
 * 300 chars.
 */

export interface FailedAttempt {
  turn: number;
  /** Short fingerprint of the attempt — typically first 2 lines of patch + header. */
  fingerprint: string;
  /** Reason the parser or applier rejected the patch. */
  reason: string;
  /** Category we inferred — helps model see a pattern across attempts. */
  category: "parse_error" | "hunk_mismatch" | "path_blocked" | "other";
}

export class RetryMemory {
  private attempts: FailedAttempt[] = [];

  /**
   * Record a failed apply_patch attempt. `patch` is the raw envelope
   * the model emitted; we extract the most salient bits for the hint.
   */
  record(turn: number, patch: string, error: string): void {
    this.attempts.push({
      turn,
      fingerprint: fingerprintPatch(patch),
      reason: error.slice(0, 300),
      category: categorize(error),
    });
  }

  /** How many prior apply_patch attempts have failed this session? */
  count(): number {
    return this.attempts.length;
  }

  /**
   * Build the feedback block to prepend to the next tool_result. Empty
   * string when there are no prior attempts (first failure gets no
   * extra hint — the raw error message is enough). Starts contributing
   * from the SECOND failure onward.
   */
  buildHint(): string {
    if (this.attempts.length === 0) return "";

    const recent = this.attempts.slice(-3);
    const categories = new Set(this.attempts.map((a) => a.category));

    const lines: string[] = [
      "",
      `⚠ This is attempt #${this.attempts.length + 1}. Previous attempts this session that FAILED (do NOT repeat these structures):`,
    ];
    for (const a of recent) {
      lines.push(`  • turn ${a.turn} [${a.category}]: ${a.fingerprint} → ${a.reason.slice(0, 180)}`);
    }

    // Category-specific coaching — short, high signal.
    if (categories.has("hunk_mismatch") && this.attempts.length >= 2) {
      lines.push("");
      lines.push(
        "Because you've hit multiple hunk mismatches, before the NEXT apply_patch:",
      );
      lines.push(
        "  1. Call read_file on EVERY file you intend to patch to get its EXACT current bytes.",
      );
      lines.push(
        "  2. Copy context lines byte-for-byte from that read — do not paraphrase, do not re-indent.",
      );
      lines.push(
        "  3. If your change inserts lines, include ONLY 1 context line above and 1 below — fewer context lines = fewer mismatch opportunities.",
      );
    }
    if (categories.has("parse_error") && this.attempts.length >= 2) {
      lines.push("");
      lines.push(
        "Parse errors repeating → check envelope syntax: every file header on its own line (no leading space), hunk header is exactly '@@' (optional context after), every body line starts with exactly ONE of ' ', '-', or '+' with NO extra leading space.",
      );
    }

    return lines.join("\n");
  }
}

function fingerprintPatch(patch: string): string {
  // Grab the first file header + first hunk header + first remove line.
  // That's enough to tell the model "you already tried this shape".
  const lines = patch.split("\n");
  const fileHeader = lines.find((l) => l.trimStart().startsWith("*** Update File:")) ?? "";
  const hunkHeader = lines.find((l) => l.trimStart().startsWith("@@")) ?? "";
  const firstRemove = lines.find((l) => l.startsWith("-") || l.startsWith(" -")) ?? "";
  const parts = [
    fileHeader.trim().slice(0, 60),
    hunkHeader.trim().slice(0, 40),
    firstRemove.trim().slice(0, 60),
  ].filter(Boolean);
  return parts.join(" | ");
}

function categorize(error: string): FailedAttempt["category"] {
  if (/parse/i.test(error) || /expected hunk header/i.test(error) || /ended with no operations/i.test(error)) {
    return "parse_error";
  }
  if (/hunk.*did not match/i.test(error) || /Expected to find/i.test(error)) {
    return "hunk_mismatch";
  }
  if (/access denied/i.test(error) || /protected/i.test(error) || /blocked/i.test(error)) {
    return "path_blocked";
  }
  return "other";
}
