import { db, alerts, projects } from "@/lib/db";
import { eq, and, gt, ne } from "drizzle-orm";
import { callAIWithUsage } from "./client";
import { SYSTEM_ANALYZER, buildAnalyzePrompt } from "./prompts";
import { getProjectOwnerAIKey, PLATFORM_MODEL } from "./get-key";
import { correlateProjectAlerts } from "./correlate";
import { computeErrorFingerprint } from "./fingerprint";
import { logAiUsage } from "./usage-logger";
import { getRedis } from "@/lib/redis";
import type { Alert } from "@/lib/db";

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

  // Resolve the project owner's userId for cost attribution.
  const [proj] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  // Analyze this alert — use GPT-4o-mini for platform key, user's model otherwise.
  const t0 = Date.now();
  let response;
  try {
    response = await callAIWithUsage(
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
      }
    );
  } catch (err) {
    if (proj) {
      logAiUsage({
        userId: proj.userId,
        projectId: alert.projectId,
        alertId: alert.id,
        feature: "auto-analyze",
        provider: aiKey.provider,
        model: aiKey.isPlatformKey ? PLATFORM_MODEL : "unknown",
        inputTokens: 0,
        outputTokens: 0,
        isPlatformKey: aiKey.isPlatformKey,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
    }
    throw err;
  }
  const reasoning = response.text;

  // Track usage for cost dashboard
  if (proj) {
    logAiUsage({
      userId: proj.userId,
      projectId: alert.projectId,
      alertId: alert.id,
      feature: "auto-analyze",
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      isPlatformKey: aiKey.isPlatformKey,
      durationMs: Date.now() - t0,
    });
  }

  await db
    .update(alerts)
    .set({ aiReasoning: reasoning })
    .where(eq(alerts.id, alert.id));

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
