"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, remediationSessions, alerts, projects, projectIntegrations } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import * as gh from "@/lib/services/github-api";
import { logAudit } from "@/lib/audit";
import { generatePostmortem } from "@/lib/ai/postmortem";

/**
 * Start a new remediation session for an alert.
 */
export async function startRemediation(
  alertId: string
): Promise<{ sessionId?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  // Load alert + verify ownership
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return { error: "Alert not found" };

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return { error: "Unauthorized" };

  // Check for an already active session
  const [existing] = await db
    .select({ id: remediationSessions.id, status: remediationSessions.status })
    .from(remediationSessions)
    .where(and(
      eq(remediationSessions.alertId, alertId),
      inArray(remediationSessions.status, ["analyzing", "reading_code", "generating_fix", "pushing", "awaiting_ci", "proposing"])
    ))
    .limit(1);

  if (existing) {
    return { sessionId: existing.id };
  }

  // Create session
  const [newSession] = await db
    .insert(remediationSessions)
    .values({
      alertId,
      projectId: alert.projectId,
      userId,
      status: "analyzing",
      attempt: 1,
      maxAttempts: 3,
      steps: [],
    })
    .returning();

  logAudit({
    userId,
    action: "remediation.start",
    resource: "alert",
    resourceId: alertId,
  });

  return { sessionId: newSession.id };
}

/**
 * Approve and merge the fix PR.
 */
export async function approveRemediation(
  sessionId: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  const [remSession] = await db
    .select()
    .from(remediationSessions)
    .where(and(eq(remediationSessions.id, sessionId), eq(remediationSessions.userId, userId)))
    .limit(1);

  if (!remSession) return { error: "Session not found" };
  if (remSession.status !== "proposing") return { error: "Session is not in proposing state" };
  if (!remSession.prNumber || !remSession.repo) return { error: "No PR to merge" };

  // Get GitHub token
  const integrations = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      eq(projectIntegrations.projectId, remSession.projectId),
      eq(projectIntegrations.service, "github")
    ))
    .limit(1);

  const ghInteg = integrations[0];
  if (!ghInteg) return { error: "GitHub integration not found" };

  const config = decryptConfig(ghInteg.configEncrypted);
  const token = config.token as string;
  const [owner, repo] = remSession.repo.split("/");

  try {
    await db
      .update(remediationSessions)
      .set({ status: "merging", updatedAt: new Date() })
      .where(eq(remediationSessions.id, sessionId));

    await gh.mergePR(token, owner, repo, remSession.prNumber);

    await db
      .update(remediationSessions)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(remediationSessions.id, sessionId));

    // Auto-resolve the alert
    await db
      .update(alerts)
      .set({ isResolved: true })
      .where(eq(alerts.id, remSession.alertId));

    // Fire-and-forget: generate post-mortem
    generatePostmortem(remSession.alertId, userId).catch(() => {});

    logAudit({
      userId,
      action: "remediation.approve",
      resource: "alert",
      resourceId: remSession.alertId,
      metadata: { prUrl: remSession.prUrl, prNumber: remSession.prNumber },
    });

    return {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Merge failed";
    await db
      .update(remediationSessions)
      .set({ status: "failed", error: msg, updatedAt: new Date() })
      .where(eq(remediationSessions.id, sessionId));
    return { error: msg };
  }
}

/**
 * Cancel an active remediation session.
 */
export async function cancelRemediation(
  sessionId: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  await db
    .update(remediationSessions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(remediationSessions.id, sessionId), eq(remediationSessions.userId, userId)));

  logAudit({
    userId,
    action: "remediation.cancel",
    resource: "remediation_session",
    resourceId: sessionId,
  });

  return {};
}
