/**
 * Fase 4 — pre-push hook telemetry.
 *
 * Isolated from prepush-hooks.ts so the hook module stays DB-free and the
 * unit test suite can run without DATABASE_URL. Caller fires this
 * fire-and-forget after runPrepushHooks returns.
 */

import { db, aiUsageLogs, remediationSessions } from "./db.js";
import { eq } from "drizzle-orm";
import type { PrepushHookResult } from "./prepush-hooks.js";

/**
 * Insert one ai_usage_logs row per ran hook so /admin/remediation-lab can
 * compute pre-push pass/fail rate. Uses feature 'prepush-<kind>' (matches
 * the `feature LIKE 'prepush-%'` filter the widget applies) and sets
 * `error` only when the hook failed — matches LensFeature semantics in
 * web/lib/ai/lens.ts.
 *
 * Never throws. Swallows individual insert failures so a slow Neon write
 * cannot block a remediation.
 */
export async function logPrepushResults(
  sessionId: string,
  results: PrepushHookResult[],
): Promise<void> {
  const runRows = results.filter((r) => r.ran);
  if (runRows.length === 0) return;

  const userId = await lookupUserId(sessionId);
  if (!userId) return;

  for (const result of runRows) {
    try {
      await db.insert(aiUsageLogs).values({
        userId,
        remediationSessionId: sessionId,
        feature: `prepush-${result.kind}`,
        provider: "prepush",
        model: "prepush",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: "0",
        isPlatformKey: false,
        error: result.passed ? null : (result.output || "failed").slice(0, 1000),
        durationMs: Math.max(0, Math.round(result.durationMs)),
        toolName: `prepush-${result.kind}`,
        toolExecMs: Math.max(0, Math.round(result.durationMs)),
      });
    } catch (err) {
      console.warn(
        "[prepush] telemetry insert failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function lookupUserId(sessionId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ userId: remediationSessions.userId })
      .from(remediationSessions)
      .where(eq(remediationSessions.id, sessionId))
      .limit(1);
    return row?.userId ?? null;
  } catch {
    return null;
  }
}
