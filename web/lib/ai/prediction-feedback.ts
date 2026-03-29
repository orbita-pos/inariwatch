/**
 * Prediction Feedback — tracks prediction accuracy and updates community patterns.
 *
 * After a PR is merged and deployed:
 * - If the predicted error occurred → correct prediction (true positive)
 * - If the predicted error did NOT occur → false positive
 * - If an error occurred that was NOT predicted → false negative (logged separately)
 *
 * This data improves future predictions by adjusting community pattern weights.
 */

import { db, predictions, alerts, errorPatterns, communityFixes } from "@/lib/db";
import { eq, and, gt, desc, sql } from "drizzle-orm";
import { computeErrorFingerprint } from "./fingerprint";

/**
 * Store a prediction for later verification.
 */
export async function storePrediction(params: {
  projectId: string;
  prNumber: number;
  repo: string;
  predictedError: string;
  predictedFile: string | null;
  predictedLine: number | null;
  confidence: number;
  riskLevel: string;
  replayRiskScore: number | null;
}): Promise<string> {
  const [row] = await db
    .insert(predictions)
    .values(params)
    .returning({ id: predictions.id });
  return row.id;
}

/**
 * Check if a prediction was correct.
 * Called after merge — looks for alerts matching the predicted error.
 *
 * @param predictionId — the prediction to verify
 * @param mergeTime — when the PR was merged (look for alerts after this)
 * @param windowMs — time window to check for matching alerts (default: 1 hour)
 */
export async function verifyPrediction(
  predictionId: string,
  mergeTime: Date,
  windowMs = 60 * 60 * 1000,
): Promise<"correct" | "false_positive"> {
  const [pred] = await db
    .select()
    .from(predictions)
    .where(eq(predictions.id, predictionId))
    .limit(1);

  if (!pred) return "false_positive";

  // Search for alerts matching the prediction
  const windowEnd = new Date(mergeTime.getTime() + windowMs);
  const matchingAlerts = await db
    .select({ id: alerts.id, title: alerts.title, body: alerts.body })
    .from(alerts)
    .where(and(
      eq(alerts.projectId, pred.projectId),
      gt(alerts.createdAt, mergeTime),
      sql`${alerts.createdAt} < ${windowEnd.toISOString()}`,
    ))
    .limit(20);

  // Check if any alert matches the predicted error
  const predictedFp = computeErrorFingerprint(pred.predictedError, pred.predictedFile ?? "");
  let matchedAlertId: string | null = null;

  for (const alert of matchingAlerts) {
    const alertFp = computeErrorFingerprint(alert.title, alert.body ?? "");
    // Match by fingerprint similarity or title containment
    if (alertFp === predictedFp ||
        alert.title.toLowerCase().includes(pred.predictedError.toLowerCase().slice(0, 30))) {
      matchedAlertId = alert.id;
      break;
    }
  }

  const outcome = matchedAlertId ? "correct" : "false_positive";

  // Update prediction with outcome
  await db
    .update(predictions)
    .set({
      outcome,
      matchedAlertId,
      resolvedAt: new Date(),
    })
    .where(eq(predictions.id, predictionId));

  // Update community pattern weights based on outcome
  if (matchedAlertId) {
    // Correct prediction — boost the pattern's occurrence count
    await boostPattern(pred.predictedError);
  }

  return outcome;
}

/**
 * Check all pending predictions for a project after a deploy.
 * Called from post-merge monitor or deploy webhook.
 */
export async function verifyPendingPredictions(
  projectId: string,
  mergeTime: Date,
): Promise<{ verified: number; correct: number; falsePositive: number }> {
  const pending = await db
    .select()
    .from(predictions)
    .where(and(
      eq(predictions.projectId, projectId),
      eq(predictions.outcome, "pending"),
    ))
    .limit(20);

  let correct = 0;
  let falsePositive = 0;

  for (const pred of pending) {
    const outcome = await verifyPrediction(pred.id, mergeTime);
    if (outcome === "correct") correct++;
    else falsePositive++;
  }

  return { verified: pending.length, correct, falsePositive };
}

/** Boost a pattern's occurrence count when prediction is verified correct */
async function boostPattern(errorText: string): Promise<void> {
  try {
    const fp = computeErrorFingerprint(errorText, "");
    const [pattern] = await db
      .select()
      .from(errorPatterns)
      .where(eq(errorPatterns.fingerprint, fp))
      .limit(1);

    if (pattern) {
      await db
        .update(errorPatterns)
        .set({
          occurrenceCount: sql`${errorPatterns.occurrenceCount} + 1`,
          lastSeenAt: new Date(),
        })
        .where(eq(errorPatterns.id, pattern.id));
    }
  } catch {
    // Non-blocking
  }
}

/**
 * Get prediction accuracy stats for a project.
 */
export async function getPredictionStats(projectId: string): Promise<{
  total: number;
  correct: number;
  falsePositive: number;
  pending: number;
  accuracy: number;
}> {
  const all = await db
    .select({ outcome: predictions.outcome })
    .from(predictions)
    .where(eq(predictions.projectId, projectId))
    .limit(500);

  const total = all.length;
  const correct = all.filter((p) => p.outcome === "correct").length;
  const falsePositive = all.filter((p) => p.outcome === "false_positive").length;
  const pending = all.filter((p) => p.outcome === "pending").length;
  const resolved = correct + falsePositive;
  const accuracy = resolved > 0 ? Math.round((correct / resolved) * 100) : 0;

  return { total, correct, falsePositive, pending, accuracy };
}
