"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { diagnoseAlert } from "@/lib/services/diagnosis.service";

export async function analyzeAlert(
  alertId: string
): Promise<{ reasoning?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  // Verify ownership
  const [alert] = await db
    .select({ id: alerts.id, projectId: alerts.projectId })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return { error: "Alert not found" };

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) return { error: "Unauthorized" };

  try {
    const result = await diagnoseAlert(alertId, userId);

    if (result.source === "none") {
      return { error: "No AI key configured. Add one in Settings → AI." };
    }

    revalidatePath(`/alerts/${alertId}`);
    return { reasoning: result.analysis };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "AI call failed" };
  }
}
