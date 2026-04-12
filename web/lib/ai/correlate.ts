import { db, alerts, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import { callAI } from "./client";
import { SYSTEM_CORRELATOR, buildCorrelatePrompt } from "./prompts";
import { getProjectOwnerAIKey, PLATFORM_MODEL } from "./get-key";
import { reservePlatformBudget, PlatformBudgetExceededError } from "./spend-guard";
import type { Alert } from "@/lib/db";

const CORRELATE_RESERVE_CENTS = 2;

/**
 * Correlate a group of newly created alerts from the same project.
 * If 2+ alerts were created in this poll run for the same project,
 * call AI to find the common root cause and update correlationData on each.
 *
 * Non-throwing — errors are caught so the cron can continue.
 */
export async function correlateProjectAlerts(
  newAlerts: Alert[],
  projectId: string
): Promise<void> {
  if (newAlerts.length < 2) return;

  const aiKey = await getProjectOwnerAIKey(projectId);
  if (!aiKey) return; // No AI key configured — skip silently

  const prompt = buildCorrelatePrompt(
    newAlerts.map((a) => ({
      title: a.title,
      severity: a.severity,
      source: a.sourceIntegrations,
      createdAt: a.createdAt.toISOString(),
    }))
  );

  // Resolve project owner for cost attribution.
  const [proj] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  // Platform-AI kill-switch: pre-reserve before the call. Skip silently
  // if the daily cap is exhausted (correlation is non-essential).
  let reservedCents = 0;
  if (aiKey.isPlatformKey) {
    try {
      await reservePlatformBudget(CORRELATE_RESERVE_CENTS);
      reservedCents = CORRELATE_RESERVE_CENTS;
    } catch (err) {
      if (err instanceof PlatformBudgetExceededError) return;
      throw err;
    }
  }

  let summary: string;
  try {
    summary = await callAI(
      aiKey.key,
      SYSTEM_CORRELATOR,
      [{ role: "user", content: prompt }],
      {
        provider: aiKey.provider,
        ...(aiKey.isPlatformKey ? { model: PLATFORM_MODEL } : {}),
        ...(proj ? {
          log: {
            userId: proj.userId,
            projectId,
            feature: "correlate" as const,
            isPlatformKey: aiKey.isPlatformKey,
            reservedPlatformCents: reservedCents,
          },
        } : {}),
      }
    );
  } catch {
    return; // Non-blocking
  }

  const correlationId = `corr_${Date.now()}`;
  const correlationData = {
    correlationId,
    groupSize: newAlerts.length,
    alertIds: newAlerts.map((a) => a.id),
    summary,
    correlatedAt: new Date().toISOString(),
  };

  // Update all alerts in the group with correlation data + AI reasoning
  await Promise.allSettled(
    newAlerts.map((alert) =>
      db
        .update(alerts)
        .set({
          correlationData,
          // Only set aiReasoning if not already set
          ...(alert.aiReasoning ? {} : { aiReasoning: summary }),
        })
        .where(eq(alerts.id, alert.id))
    )
  );
}
