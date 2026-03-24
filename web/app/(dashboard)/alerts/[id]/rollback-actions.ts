"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, projectIntegrations } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { decryptConfig } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";
import * as vercel from "@/lib/services/vercel-api";

/**
 * Rollback to the last successful Vercel production deployment.
 */
export async function rollbackVercelDeploy(
  alertId: string
): Promise<{ url?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return { error: "Alert not found" };

  // Verify ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return { error: "Unauthorized" };

  // Must be a Vercel-sourced alert
  if (!alert.sourceIntegrations.includes("vercel")) {
    return { error: "This alert is not from Vercel." };
  }

  // Get Vercel integration
  const [integration] = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      eq(projectIntegrations.projectId, alert.projectId),
      eq(projectIntegrations.service, "vercel"),
      eq(projectIntegrations.isActive, true)
    ))
    .limit(1);

  if (!integration) return { error: "No active Vercel integration found." };

  const config = decryptConfig(integration.configEncrypted);
  const token = config.token as string;
  const teamId = config.teamId as string | undefined;
  // projectId is stored in the Vercel integration config (e.g. "prj_xxx")
  const vercelProjectId = (config.projectId as string | undefined) ?? project.name;

  if (!token) return { error: "Vercel token not found in integration config." };

  // Extract project name from alert title (pattern: "Deploy failed — {name}")
  const nameMatch = alert.title.match(/—\s+(.+)$/);
  const projectName = nameMatch?.[1]?.trim() ?? vercelProjectId;

  try {
    // Find last successful deployment
    const lastGood = await vercel.getLastSuccessfulDeploy(token, teamId, vercelProjectId);
    if (!lastGood) {
      return { error: "No successful production deployment found to rollback to." };
    }

    // Perform rollback
    const result = await vercel.rollbackToDeployment(token, teamId, lastGood.uid, projectName);

    // Auto-resolve the alert
    await db
      .update(alerts)
      .set({ isResolved: true, isRead: true })
      .where(eq(alerts.id, alertId));

    logAudit({
      userId,
      action: "alert.vercel_rollback",
      resource: "alert",
      resourceId: alertId,
      metadata: { deploymentId: lastGood.uid, url: result.url },
    });

    revalidatePath(`/alerts/${alertId}`);
    revalidatePath("/alerts");

    return { url: result.url || lastGood.url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Rollback failed";
    return { error: msg };
  }
}
