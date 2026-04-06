/**
 * Learning from Failed Fixes
 *
 * Records why fixes fail (CI error, self-review reject, post-merge regression)
 * and injects anti-patterns into future fix prompts so the AI doesn't repeat
 * the same mistakes.
 */

import { db, failedFixes, confidenceCalibration } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";

// ── Record Failures ─────────────────────────────────────────────────────────

export async function recordFailedFix(params: {
  projectId: string;
  errorFingerprint: string;
  fixSummary: string;
  failureReason: string;
  filesTouched: string[];
}): Promise<void> {
  await db.insert(failedFixes).values({
    projectId: params.projectId,
    errorFingerprint: params.errorFingerprint,
    attemptedFixSummary: params.fixSummary.slice(0, 2000),
    failureReason: params.failureReason.slice(0, 2000),
    filesTouched: params.filesTouched,
  });
}

// ── Get Anti-Patterns for Prompt Injection ──────────────────────────────────

export interface AntiPattern {
  fixSummary: string;
  failureReason: string;
  filesTouched: string[];
  failedAt: Date;
}

/**
 * Get past failed fixes for the same error fingerprint (or same files).
 * Returns up to 3 most recent failures for injection into the fix prompt.
 */
export async function getAntiPatterns(
  projectId: string,
  errorFingerprint: string,
  filesToRead: string[],
): Promise<AntiPattern[]> {
  // First: exact fingerprint match
  const byFingerprint = await db.select({
    attemptedFixSummary: failedFixes.attemptedFixSummary,
    failureReason: failedFixes.failureReason,
    filesTouched: failedFixes.filesTouched,
    failedAt: failedFixes.failedAt,
  })
    .from(failedFixes)
    .where(and(
      eq(failedFixes.projectId, projectId),
      eq(failedFixes.errorFingerprint, errorFingerprint),
    ))
    .orderBy(desc(failedFixes.failedAt))
    .limit(3);

  if (byFingerprint.length > 0) {
    return byFingerprint.map((r) => ({
      fixSummary: r.attemptedFixSummary,
      failureReason: r.failureReason,
      filesTouched: (r.filesTouched as string[]) ?? [],
      failedAt: new Date(r.failedAt),
    }));
  }

  // Fallback: match by files in common (if no fingerprint match)
  if (filesToRead.length === 0) return [];

  const byFiles = await db.select({
    attemptedFixSummary: failedFixes.attemptedFixSummary,
    failureReason: failedFixes.failureReason,
    filesTouched: failedFixes.filesTouched,
    failedAt: failedFixes.failedAt,
  })
    .from(failedFixes)
    .where(eq(failedFixes.projectId, projectId))
    .orderBy(desc(failedFixes.failedAt))
    .limit(20);

  // Filter to entries that share files
  return byFiles
    .filter((r) => {
      const touched = (r.filesTouched as string[]) ?? [];
      return touched.some((f) => filesToRead.includes(f));
    })
    .slice(0, 3)
    .map((r) => ({
      fixSummary: r.attemptedFixSummary,
      failureReason: r.failureReason,
      filesTouched: (r.filesTouched as string[]) ?? [],
      failedAt: new Date(r.failedAt),
    }));
}

/**
 * Build the anti-pattern context string for injection into the fix prompt.
 */
export function buildAntiPatternContext(patterns: AntiPattern[]): string {
  if (patterns.length === 0) return "";

  const entries = patterns.map((p, i) =>
    `Attempt ${i + 1}: ${p.fixSummary.slice(0, 300)}\n  Failed because: ${p.failureReason.slice(0, 300)}\n  Files: ${p.filesTouched.join(", ")}`
  ).join("\n\n");

  return `\n\nPREVIOUS FAILED FIX ATTEMPTS for this error (DO NOT repeat these approaches):\n${entries}\n\nYou MUST try a DIFFERENT strategy than the ones listed above.`;
}

// ── Confidence Calibration ──────────────────────────────────────────────────

export async function recordCalibrationPoint(
  projectId: string,
  predictedConfidence: number,
  actualOutcome: boolean,
): Promise<void> {
  await db.insert(confidenceCalibration).values({
    projectId,
    predictedConfidence,
    actualOutcome,
  });
}

export interface CalibrationBucket {
  bucket: string;
  predictions: number;
  successes: number;
  actualRate: number;
}

/**
 * Get calibration data for a project — how well does the AI's confidence
 * correlate with actual success rates?
 */
export async function getCalibrationScore(projectId: string): Promise<CalibrationBucket[]> {
  const rows = await db.select()
    .from(confidenceCalibration)
    .where(eq(confidenceCalibration.projectId, projectId));

  const buckets = [
    { label: "0-30", min: 0, max: 30 },
    { label: "31-60", min: 31, max: 60 },
    { label: "61-90", min: 61, max: 90 },
    { label: "91-100", min: 91, max: 100 },
  ];

  return buckets.map((b) => {
    const inBucket = rows.filter((r) => r.predictedConfidence >= b.min && r.predictedConfidence <= b.max);
    const successes = inBucket.filter((r) => r.actualOutcome).length;
    return {
      bucket: b.label,
      predictions: inBucket.length,
      successes,
      actualRate: inBucket.length > 0 ? successes / inBucket.length : 0,
    };
  });
}

/**
 * Adjust a raw confidence score based on historical calibration data.
 * Returns the raw score if not enough data (< 10 points).
 */
export async function adjustConfidence(
  rawConfidence: number,
  projectId: string,
): Promise<{ adjusted: number; calibrated: boolean }> {
  const rows = await db.select()
    .from(confidenceCalibration)
    .where(eq(confidenceCalibration.projectId, projectId));

  if (rows.length < 10) return { adjusted: rawConfidence, calibrated: false };

  // Find the bucket this confidence falls into
  const inRange = rows.filter((r) =>
    Math.abs(r.predictedConfidence - rawConfidence) <= 15 // ±15% window
  );

  if (inRange.length < 5) return { adjusted: rawConfidence, calibrated: false };

  const actualRate = inRange.filter((r) => r.actualOutcome).length / inRange.length;
  const adjusted = Math.max(10, Math.round(actualRate * 100));

  return { adjusted, calibrated: true };
}
