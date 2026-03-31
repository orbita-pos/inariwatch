import { db, alerts, apiKeys } from "@/lib/db";
import { eq } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { callAI } from "@/lib/ai/client";
import type { McpUser } from "../auth";
import { userCanAccessProject } from "../helpers";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const alertId = args.alert_id as string;
  if (!alertId) return "Error: alert_id is required.";

  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return `Error: Alert not found: ${alertId}`;
  if (!(await userCanAccessProject(user.userId, alert.projectId)))
    return "Error: Alert does not belong to your projects.";

  // If already analyzed, return the existing analysis
  if (alert.aiReasoning) {
    return JSON.stringify(
      {
        alert_id: alertId,
        title: alert.title,
        severity: alert.severity,
        root_cause_analysis: alert.aiReasoning,
        source: "cached",
      },
      null,
      2
    );
  }

  // Try to get user's AI key for deep analysis
  const AI_SERVICES = ["claude", "openai", "grok", "deepseek", "gemini"];
  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.userId));

  const aiKey = keys.find((k) => AI_SERVICES.includes(k.service));

  if (!aiKey) {
    // No AI key — return a sampling request so the client's LLM can analyze
    const samplingSystemPrompt = `You are an expert SRE analyzing a production alert. Provide a structured root cause analysis:
1. Root Cause (most likely)
2. Impact Assessment
3. Suggested Fix (specific, actionable)
4. Prevention Steps

Be concise and technical.`;

    const userMessage = `Alert: ${alert.title}\nSeverity: ${alert.severity}\nSources: ${(alert.sourceIntegrations ?? []).join(", ")}\n\nDetails:\n${alert.body ?? "No details available."}`;

    return JSON.stringify(
      {
        alert_id: alertId,
        title: alert.title,
        severity: alert.severity,
        _sampling_request: {
          description: "No AI key configured. Use your client LLM to analyze this alert, then call sampling/createMessage with the result.",
          messages: [{ role: "user", content: { type: "text", text: userMessage } }],
          systemPrompt: samplingSystemPrompt,
          context: { alert_id: alertId },
          maxTokens: 2000,
        },
      },
      null,
      2
    );
  }

  const decryptedKey = decrypt(aiKey.keyEncrypted);

  const systemPrompt = `You are an expert SRE analyzing a production alert. Provide a structured root cause analysis:
1. Root Cause (most likely)
2. Impact Assessment
3. Suggested Fix (specific, actionable)
4. Prevention Steps

Be concise and technical.`;

  const userMessage = `Alert: ${alert.title}\nSeverity: ${alert.severity}\nSources: ${(alert.sourceIntegrations ?? []).join(", ")}\n\nDetails:\n${alert.body ?? "No details available."}`;

  try {
    const result = await callAI(decryptedKey, systemPrompt, [
      { role: "user", content: userMessage },
    ]);

    // Save the analysis
    await db
      .update(alerts)
      .set({ aiReasoning: result })
      .where(eq(alerts.id, alertId));

    return JSON.stringify(
      {
        alert_id: alertId,
        title: alert.title,
        severity: alert.severity,
        root_cause_analysis: result,
        source: "ai",
      },
      null,
      2
    );
  } catch (e) {
    return `Error running AI analysis: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
