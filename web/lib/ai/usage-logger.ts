/**
 * Central helper for logging AI usage to `ai_usage_logs`.
 *
 * Every feature that makes AI calls (auto-analyze, remediation, chat,
 * security scan, etc.) should call `logAiUsage()` after each call so
 * users can see exactly what their BYOK key is being spent on in the
 * `/analytics/ai-usage` dashboard.
 *
 * The logger is fire-and-forget — it never throws, because cost tracking
 * should never break the actual AI feature.
 */

import { db, aiUsageLogs } from "@/lib/db";
import { computeCost } from "./pricing";
import { reconcilePlatformSpend } from "./spend-guard";

export type AiFeature =
  | "auto-analyze"
  | "remediation"
  | "chat"
  | "security-scan"
  | "risk-assessment"
  | "postmortem"
  | "correlate"
  | "context-gather"
  | "self-review"
  | "other";

export interface LogAiUsageInput {
  userId: string;
  projectId?: string | null;
  alertId?: string | null;
  remediationSessionId?: string | null;
  feature: AiFeature;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  isPlatformKey?: boolean;
  /**
   * Cents pre-reserved against the platform AI budget via
   * `reservePlatformBudget()`. Used by `reconcilePlatformSpend()` after the
   * call completes to adjust the daily counter by (actual - reserved).
   * Pass 0 (or omit) when the caller didn't pre-reserve.
   */
  reservedPlatformCents?: number;
  error?: string | null;
  durationMs?: number | null;
}

/**
 * Log an AI call to the usage tracking table.
 *
 * Fire-and-forget: errors are swallowed. Cost tracking must never block
 * or break the calling feature. If the DB is unavailable, we log to
 * stderr but don't throw.
 */
export async function logAiUsage(input: LogAiUsageInput): Promise<void> {
  try {
    const cost = computeCost(
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.cachedInputTokens ?? 0
    );

    await db.insert(aiUsageLogs).values({
      userId: input.userId,
      projectId: input.projectId ?? null,
      alertId: input.alertId ?? null,
      remediationSessionId: input.remediationSessionId ?? null,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      costUsd: cost.toFixed(8),
      isPlatformKey: input.isPlatformKey ?? false,
      error: input.error ?? null,
      durationMs: input.durationMs ?? null,
    });

    // Reconcile platform spend kill-switch counter. Only when the call
    // actually used the platform key — BYOK calls don't touch the counter.
    //
    // Three cases:
    //   - Success with reservation: delta = (actual - reserved), can be ±
    //   - Error with reservation:   delta = (0 - reserved), refunds
    //   - Success without reserve:  delta = actual, charges full
    if (input.isPlatformKey) {
      const actualCents = cost > 0 ? Math.ceil(cost * 100) : 0;
      const estCents = input.reservedPlatformCents ?? 0;
      if (actualCents > 0 || estCents > 0) {
        await reconcilePlatformSpend(estCents, actualCents);
      }
    }
  } catch (err) {
    // Never crash the feature over logging failure.
    console.error("[ai-usage-logger] Failed to log usage:", err);
  }
}
