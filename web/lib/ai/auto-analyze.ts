import { db, alerts, projects } from "@/lib/db";
import { eq, and, gt, ne, sql } from "drizzle-orm";
import { callAI } from "./client";
import { SYSTEM_ANALYZER, buildAnalyzePrompt } from "./prompts";
import { getProjectOwnerAIKey, PLATFORM_MODEL } from "./get-key";
import { correlateProjectAlerts } from "./correlate";
import { computeErrorFingerprint } from "./fingerprint";
import { classifyAlert, type ClassificationResult } from "./alert-classifier";
import { assertWithinQuota, incrementQuota, QuotaExceededError } from "./quota";
import { reservePlatformBudget, PlatformBudgetExceededError } from "./spend-guard";
import { getRedis } from "@/lib/redis";
import type { Alert } from "@/lib/db";

// Pessimistic estimate for one auto-analyze call (Haiku/4o-mini, 300 max
// tokens out, ~2K tokens in). Reconciled to actual after the call.
const AUTO_ANALYZE_RESERVE_CENTS = 2;

/**
 * Auto-analyze a newly created alert with AI and persist the reasoning.
 * Also triggers correlation if there are other recent alerts for the same project.
 *
 * Non-throwing, fire-and-forget — call with .catch(() => {}).
 */
export async function autoAnalyzeAlert(alert: Alert): Promise<void> {
  const aiKey = await getProjectOwnerAIKey(alert.projectId);
  if (!aiKey) return;

  // Check Redis cache — same fingerprint = same diagnosis (saves AI call + $0.005)
  const fingerprint = computeErrorFingerprint(alert.title, alert.body ?? "");
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get<string>(`ai_diag:${fingerprint}`);
      if (cached) {
        await db.update(alerts).set({ aiReasoning: cached }).where(eq(alerts.id, alert.id));
        return;
      }
    } catch {
      // Redis unavailable — proceed with AI call
    }
  }

  // Resolve project owner for cost attribution + quota.
  const [proj] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  // Check quota before making the AI call.
  if (proj) {
    try {
      await assertWithinQuota(proj.userId, "auto-analyze");
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        // Skip silently — user will see "limit reached" in dashboard
        return;
      }
      throw err;
    }
  }

  // Platform-AI kill-switch: pre-reserve estimated cost. Reconciled to
  // actual in usage-logger after the call. Throws PlatformBudgetExceededError
  // when the daily cap is hit — caller catches and persists aiSkippedReason.
  let reservedCents = 0;
  if (aiKey.isPlatformKey) {
    try {
      await reservePlatformBudget(AUTO_ANALYZE_RESERVE_CENTS);
      reservedCents = AUTO_ANALYZE_RESERVE_CENTS;
    } catch (err) {
      if (err instanceof PlatformBudgetExceededError) {
        // Persist reason so the alert page can show a banner.
        await db
          .update(alerts)
          .set({ aiSkippedReason: "platform_budget" })
          .where(eq(alerts.id, alert.id));
        return;
      }
      throw err;
    }
  }

  // Classify alert to determine cheapest effective path.
  // Fine-tuned model (~$0.0001) or heuristic fallback (free).
  let classification: ClassificationResult | null = null;
  try {
    classification = await classifyAlert(
      alert.title,
      alert.body ?? "",
      alert.severity,
      alert.sourceIntegrations,
      aiKey.isPlatformKey ? aiKey.key : undefined,
    );
  } catch {
    // Classifier unavailable — proceed with full analysis
  }

  // For triage_only alerts from high-confidence classifier, use a shorter prompt
  // that costs fewer tokens. For auto_fix, still analyze (the fix itself is cheap
  // but we need aiReasoning for the dashboard).
  const analyzePrompt = buildAnalyzePrompt({
    title: alert.title,
    severity: alert.severity,
    body: alert.body ?? "",
    sourceIntegrations: alert.sourceIntegrations,
  });

  // Analyze this alert — use GPT-4o-mini for platform key, user's model otherwise.
  const reasoning = await callAI(
    aiKey.key,
    SYSTEM_ANALYZER,
    [{ role: "user", content: buildAnalyzePrompt({
      title: alert.title,
      severity: alert.severity,
      body: alert.body ?? "",
      sourceIntegrations: alert.sourceIntegrations,
    }) }],
    {
      maxTokens: 300,
      provider: aiKey.provider,
      ...(aiKey.isPlatformKey ? { model: PLATFORM_MODEL } : {}),
      ...(proj ? {
        log: {
          userId: proj.userId,
          projectId: alert.projectId,
          alertId: alert.id,
          feature: "auto-analyze" as const,
          isPlatformKey: aiKey.isPlatformKey,
          reservedPlatformCents: reservedCents,
        },
      } : {}),
    }
  );

  await db
    .update(alerts)
    .set({
      aiReasoning: reasoning,
      ...(classification ? {
        // Atomic jsonb merge — preserves any correlationData written by correlate.ts
        // between when we read the alert and now (avoids race condition overwrite).
        correlationData: sql`COALESCE(${alerts.correlationData}, '{}'::jsonb) || ${JSON.stringify({
          triageClass: classification.triageClass,
          triageConfidence: classification.confidence,
          triageMethod: classification.method,
        })}::jsonb`,
      } : {}),
    })
    .where(eq(alerts.id, alert.id));

  // Increment quota after successful call
  if (proj) {
    incrementQuota(proj.userId, "auto-analyze").catch(() => {});
  }

  // Cache diagnosis by fingerprint (1h TTL)
  if (redis && reasoning) {
    redis.set(`ai_diag:${fingerprint}`, reasoning, { ex: 3600 }).catch(() => {});
  }

  // Post AI diagnosis to Slack thread (if alert has one)
  try {
    const { sendThreadReply } = await import("@/lib/slack/send");
    sendThreadReply(alert.id, `*AI Diagnosis:*\n${reasoning}`).catch(() => {});
  } catch {
    // Non-blocking
  }

  // Correlation: look for other recent alerts from the same project (last 30 min)
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const recentSiblings = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, alert.projectId),
        gt(alerts.createdAt, thirtyMinAgo),
        ne(alerts.id, alert.id)
      )
    );

  if (recentSiblings.length >= 1) {
    // Pass the full group (this alert + siblings) to the correlator
    await correlateProjectAlerts([alert, ...recentSiblings], alert.projectId);
  }
}
