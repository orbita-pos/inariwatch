"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, remediationSessions } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { callAI } from "@/lib/ai/client";
import { getProjectOwnerAIKey } from "@/lib/ai/get-key";
import { resolveModel } from "@/lib/ai/models";
import type { RemediationStep } from "@/lib/db/schema";

const SYSTEM_POSTMORTEM = `You are an expert SRE writing a post-mortem document.
Write in a clear, factual, blame-free tone.
Use markdown formatting with ## headers.
Be specific about timestamps, root causes, and actions.
Keep it under 600 words.`;

export async function generatePostmortemAction(
  alertId: string
): Promise<{ postmortem?: string; error?: string }> {
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

  const aiKey = await getProjectOwnerAIKey(alert.projectId);
  if (!aiKey) return { error: "No AI key configured. Add one in Settings." };

  // Get latest remediation session if any
  const [remediation] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.alertId, alertId))
    .orderBy(desc(remediationSessions.createdAt))
    .limit(1);

  const steps = remediation
    ? ((remediation.steps ?? []) as RemediationStep[])
        .map((s) => `- [${s.timestamp}] ${s.message} (${s.status})`)
        .join("\n")
    : "No remediation steps recorded.";

  const prompt = `Generate a post-mortem document for this resolved incident.

INCIDENT:
Title: ${alert.title}
Severity: ${alert.severity}
Source: ${alert.sourceIntegrations.join(", ")}
Detected at: ${alert.createdAt.toISOString()}
Details: ${alert.body.slice(0, 2000)}

${alert.aiReasoning ? `AI ANALYSIS:\n${alert.aiReasoning.slice(0, 1000)}\n` : ""}
${remediation ? `REMEDIATION:
Repository: ${remediation.repo ?? "unknown"}
Branch: ${remediation.branch ?? "unknown"}
Attempts: ${remediation.attempt}
${remediation.prUrl ? `PR: ${remediation.prUrl}` : "No PR created"}

TIMELINE:
${steps}` : "No automated remediation was performed — resolved manually."}

Generate the post-mortem with these sections:
## Summary
## Timeline
## Root Cause
## Impact
## Resolution
## Prevention Measures

Be specific. Use the actual data above.`;

  try {
    const model = resolveModel("postmortem", aiKey.provider, aiKey.modelPrefs);
    const postmortem = await callAI(aiKey.key, SYSTEM_POSTMORTEM, [
      { role: "user", content: prompt },
    ], { maxTokens: 2048, timeout: 45000, model });

    // Persist to DB
    await db.update(alerts).set({ postmortem }).where(eq(alerts.id, alertId));

    revalidatePath(`/alerts/${alertId}`);
    return { postmortem };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate post-mortem";
    return { error: msg };
  }
}
