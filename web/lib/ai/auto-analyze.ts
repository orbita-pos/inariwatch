import { db, alerts } from "@/lib/db";
import { eq, and, gt, ne } from "drizzle-orm";
import { callAI } from "./client";
import { SYSTEM_ANALYZER, buildAnalyzePrompt } from "./prompts";
import { getProjectOwnerAIKey, PLATFORM_MODEL } from "./get-key";
import { correlateProjectAlerts } from "./correlate";
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

  // Analyze this alert — use Haiku for platform key (free tier), user's model otherwise
  const reasoning = await callAI(
    aiKey.key,
    SYSTEM_ANALYZER,
    [{ role: "user", content: buildAnalyzePrompt({
      title: alert.title,
      severity: alert.severity,
      body: alert.body ?? "",
      sourceIntegrations: alert.sourceIntegrations,
    }) }],
    { maxTokens: 300, ...(aiKey.isPlatformKey ? { model: PLATFORM_MODEL } : {}) }
  );

  await db
    .update(alerts)
    .set({ aiReasoning: reasoning })
    .where(eq(alerts.id, alert.id));

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
