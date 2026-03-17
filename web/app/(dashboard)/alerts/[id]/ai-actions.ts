"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getUserAIKey } from "@/lib/ai/get-key";
import { callAI } from "@/lib/ai/client";
import { SYSTEM_ANALYZER, buildAnalyzePrompt } from "@/lib/ai/prompts";
import { revalidatePath } from "next/cache";

export async function analyzeAlert(
  alertId: string
): Promise<{ reasoning?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  // Load alert + verify ownership
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return { error: "Alert not found" };

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) return { error: "Unauthorized" };

  // Get AI key
  const aiKey = await getUserAIKey(userId);
  if (!aiKey) return { error: "No AI key configured. Add one in Settings → AI." };

  // Build prompt and call AI
  const prompt = buildAnalyzePrompt({
    title: alert.title,
    severity: alert.severity,
    body: alert.body ?? "",
    sourceIntegrations: alert.sourceIntegrations,
  });

  let reasoning: string;
  try {
    reasoning = await callAI(aiKey.key, SYSTEM_ANALYZER, [
      { role: "user", content: prompt },
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    return { error: msg };
  }

  // Persist the reasoning
  await db
    .update(alerts)
    .set({ aiReasoning: reasoning })
    .where(eq(alerts.id, alertId));

  revalidatePath(`/alerts/${alertId}`);
  return { reasoning };
}
