"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { generatePostmortem } from "@/lib/ai/postmortem";

async function getAlertWithOwnership(alertId: string) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) throw new Error("Unauthorized");

  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) throw new Error("Not found");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) throw new Error("Forbidden");

  return { alert, userId };
}

export async function markAlertRead(alertId: string) {
  const { userId } = await getAlertWithOwnership(alertId);
  await db.update(alerts).set({ isRead: true }).where(eq(alerts.id, alertId));
  logAudit({ userId, action: "alert.read", resource: "alert", resourceId: alertId });
  revalidatePath(`/alerts/${alertId}`);
  revalidatePath("/alerts");
  revalidatePath("/dashboard");
}

export async function markAlertResolved(alertId: string) {
  const { userId } = await getAlertWithOwnership(alertId);
  await db.update(alerts).set({ isResolved: true, isRead: true }).where(eq(alerts.id, alertId));
  logAudit({ userId, action: "alert.resolve", resource: "alert", resourceId: alertId });

  // Fire-and-forget: generate post-mortem in background
  generatePostmortem(alertId, userId).catch(() => {});

  revalidatePath(`/alerts/${alertId}`);
  revalidatePath("/alerts");
  revalidatePath("/dashboard");
}

export async function reopenAlert(alertId: string) {
  const { userId } = await getAlertWithOwnership(alertId);
  await db.update(alerts).set({ isResolved: false }).where(eq(alerts.id, alertId));
  logAudit({ userId, action: "alert.reopen", resource: "alert", resourceId: alertId });
  revalidatePath(`/alerts/${alertId}`);
  revalidatePath("/alerts");
}
