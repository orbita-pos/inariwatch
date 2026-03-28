import { db, alerts, remediationSessions, slackUserLinks } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";

/**
 * Core alert/remediation actions — no NextAuth dependency.
 * Used by both Slack bot and web dashboard (after extracting from server actions).
 */

/** Resolve a Slack user ID to an InariWatch user ID */
export async function resolveSlackUser(
  slackUserId: string,
  installationId: string,
): Promise<string | null> {
  const [link] = await db
    .select()
    .from(slackUserLinks)
    .where(and(
      eq(slackUserLinks.slackUserId, slackUserId),
      eq(slackUserLinks.installationId, installationId),
    ))
    .limit(1);
  return link?.userId ?? null;
}

/** Verify a user has access to the alert's project */
async function verifyAccess(userId: string, alertId: string): Promise<boolean> {
  const [alert] = await db.select({ projectId: alerts.projectId }).from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return false;

  const projectIds = await getUserProjectIds(userId);
  return projectIds.includes(alert.projectId);
}

export async function acknowledgeAlertCore(
  alertId: string,
  userId: string,
): Promise<{ error?: string }> {
  if (!(await verifyAccess(userId, alertId))) return { error: "Access denied" };

  await db.update(alerts).set({ isRead: true }).where(eq(alerts.id, alertId));
  return {};
}

export async function resolveAlertCore(
  alertId: string,
  userId: string,
): Promise<{ error?: string }> {
  if (!(await verifyAccess(userId, alertId))) return { error: "Access denied" };

  await db
    .update(alerts)
    .set({ isRead: true, isResolved: true })
    .where(eq(alerts.id, alertId));
  return {};
}

export async function approveRemediationCore(
  sessionId: string,
  userId: string,
): Promise<{ error?: string }> {
  const [session] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.id, sessionId))
    .limit(1);

  if (!session) return { error: "Session not found" };
  if (session.status !== "proposing") return { error: `Cannot approve: status is ${session.status}` };

  const projectIds = await getUserProjectIds(userId);
  if (!projectIds.includes(session.projectId)) return { error: "Access denied" };

  // Mark as approved — the remediation engine handles the actual merge
  await db
    .update(remediationSessions)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(remediationSessions.id, sessionId));

  return {};
}

export async function cancelRemediationCore(
  sessionId: string,
  userId: string,
): Promise<{ error?: string }> {
  const [session] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.id, sessionId))
    .limit(1);

  if (!session) return { error: "Session not found" };

  const projectIds = await getUserProjectIds(userId);
  if (!projectIds.includes(session.projectId)) return { error: "Access denied" };

  await db
    .update(remediationSessions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(remediationSessions.id, sessionId));

  return {};
}
