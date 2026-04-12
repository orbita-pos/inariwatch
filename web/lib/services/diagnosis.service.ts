/**
 * Diagnosis service — AI root cause analysis.
 * Used by: dashboard ai-actions (callAI server-side).
 * MCP get_root_cause imports prompts only (DIAGNOSIS_PROMPT, buildAnalyzePrompt) for sampling.
 * Source of truth for prompt + analysis logic.
 */

import { db, alerts, apiKeys } from "@/lib/db";
import { eq } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { callAI } from "@/lib/ai/client";
import { SYSTEM_ANALYZER, buildAnalyzePrompt } from "@/lib/ai/prompts";
import { getUserAIKey } from "@/lib/ai/get-key";
import { resolveModel } from "@/lib/ai/models";

export type DiagnosisResult = {
  analysis: string;
  source: "cached" | "ai" | "none";
};

/**
 * Get or generate root cause analysis for an alert.
 * Returns cached analysis if available, otherwise calls AI.
 * Uses the prompt library from lib/ai/prompts.ts (single source of truth).
 */
export async function diagnoseAlert(
  alertId: string,
  userId: string
): Promise<DiagnosisResult> {
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) throw new Error(`Alert not found: ${alertId}`);

  // Return cached if available
  if (alert.aiReasoning) {
    return { analysis: alert.aiReasoning, source: "cached" };
  }

  // Try getUserAIKey first (handles model prefs + provider detection)
  const aiKey = await getUserAIKey(userId);
  if (!aiKey) {
    // Fallback: check raw apiKeys table (for MCP tokens where getUserAIKey may not work)
    const AI_SERVICES = ["claude", "openai", "grok", "deepseek", "gemini"];
    const keys = await db.select().from(apiKeys).where(eq(apiKeys.userId, userId));
    const rawKey = keys.find((k) => AI_SERVICES.includes(k.service));
    if (!rawKey) return { analysis: "", source: "none" };

    const decryptedKey = decrypt(rawKey.keyEncrypted);
    const prompt = buildAnalyzePrompt({
      title: alert.title,
      severity: alert.severity,
      body: alert.body ?? "",
      sourceIntegrations: alert.sourceIntegrations,
    });

    const result = await callAI(decryptedKey, SYSTEM_ANALYZER, [
      { role: "user", content: prompt },
    ]);

    await db.update(alerts).set({ aiReasoning: result }).where(eq(alerts.id, alertId));
    return { analysis: result, source: "ai" };
  }

  // Use getUserAIKey result (has model prefs, provider)
  const prompt = buildAnalyzePrompt({
    title: alert.title,
    severity: alert.severity,
    body: alert.body ?? "",
    sourceIntegrations: alert.sourceIntegrations,
  });

  const model = resolveModel("analysis", aiKey.provider, aiKey.modelPrefs);
  const result = await callAI(aiKey.key, SYSTEM_ANALYZER, [
    { role: "user", content: prompt },
  ], { model, provider: aiKey.provider });

  await db.update(alerts).set({ aiReasoning: result }).where(eq(alerts.id, alertId));
  return { analysis: result, source: "ai" };
}

/** Exposed for MCP sampling fallback */
export { SYSTEM_ANALYZER as DIAGNOSIS_PROMPT, buildAnalyzePrompt };
