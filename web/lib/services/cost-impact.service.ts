/**
 * Cost Impact service — VAR Gate 14.
 *
 * Aggregates AI spend from ai_usage_logs for a given remediation and
 * snapshots the result into cost_impact_runs for audit. Synchronous
 * scoring (no BullMQ worker) — same pattern as Gate 15/16. The query
 * is a single SUM/GROUP BY over ai_usage_logs with an index on
 * remediation_session_id, so it runs in <50ms.
 *
 * Skip outcomes (passed=null, auto-merge treats as skip):
 *   no-logs  — zero ai_usage_logs rows for this remediation
 *             (AI went through an unlogged path — gate can't measure)
 */

import { db } from "@/lib/db";
import {
  aiUsageLogs,
  costImpactRuns,
  type CostImpactRun,
} from "@/lib/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

export const DEFAULT_THRESHOLD_USD = 1.0;

// ── Public shapes ────────────────────────────────────────────────────────

export interface CostFeatureBreakdown {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

export interface CostImpactStatus {
  runId: string;
  status: "running" | "completed" | "failed";
  remediationCostUsd: number;
  tokenCountInput: number;
  tokenCountOutput: number;
  tokenCountCached: number;
  callCount: number;
  costBreakdown: Record<string, CostFeatureBreakdown>;
  thresholdUsd: number;
  passed: boolean | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface StartInput {
  alertId: string;
  remediationId: string;
  fixCommitSha: string;
  thresholdUsd?: number;
}

// ── Public API ───────────────────────────────────────────────────────────

export async function startOrGetCostImpact(input: StartInput): Promise<{
  runId: string;
  created: boolean;
  status: CostImpactStatus;
}> {
  const thresholdUsd = input.thresholdUsd ?? DEFAULT_THRESHOLD_USD;

  const [existing] = await db
    .select()
    .from(costImpactRuns)
    .where(
      and(
        eq(costImpactRuns.alertId, input.alertId),
        eq(costImpactRuns.remediationId, input.remediationId),
        eq(costImpactRuns.fixCommitSha, input.fixCommitSha),
      ),
    )
    .limit(1);

  if (existing && existing.status !== "failed") {
    const refreshed = await readRun(existing.id);
    if (!refreshed) throw new Error(`cost impact ${existing.id} vanished`);
    return { runId: existing.id, created: false, status: refreshed };
  }

  let runId: string;
  if (existing) {
    await db
      .update(costImpactRuns)
      .set({
        status: "running",
        error: null,
        completedAt: null,
        startedAt: new Date(),
        remediationCostUsd: "0",
        tokenCountInput: 0,
        tokenCountOutput: 0,
        tokenCountCached: 0,
        callCount: 0,
        costBreakdown: {},
        passed: null,
        thresholdUsd: String(thresholdUsd),
      })
      .where(eq(costImpactRuns.id, existing.id));
    runId = existing.id;
  } else {
    const [inserted] = await db
      .insert(costImpactRuns)
      .values({
        alertId: input.alertId,
        remediationId: input.remediationId,
        fixCommitSha: input.fixCommitSha,
        thresholdUsd: String(thresholdUsd),
        status: "running",
      })
      .returning({ id: costImpactRuns.id });
    runId = inserted.id;
  }

  await scoreAndPersist(runId);

  const status = await readRun(runId);
  if (!status) throw new Error(`cost impact ${runId} failed to insert`);
  return { runId, created: !existing, status };
}

export async function getCostImpactForAlert(
  alertId: string,
): Promise<CostImpactStatus | null> {
  const [row] = await db
    .select()
    .from(costImpactRuns)
    .where(eq(costImpactRuns.alertId, alertId))
    .orderBy(desc(costImpactRuns.startedAt))
    .limit(1);
  return row ? shape(row) : null;
}

// ── Scoring ──────────────────────────────────────────────────────────────

async function scoreAndPersist(runId: string): Promise<void> {
  try {
    const [run] = await db
      .select()
      .from(costImpactRuns)
      .where(eq(costImpactRuns.id, runId))
      .limit(1);
    if (!run) return;

    // Aggregate cost + tokens per (feature) for this remediation.
    const breakdownRows = await db
      .select({
        feature: aiUsageLogs.feature,
        costUsd: sql<string>`SUM(${aiUsageLogs.costUsd})::text`,
        inputTokens: sql<number>`SUM(${aiUsageLogs.inputTokens})::int`,
        outputTokens: sql<number>`SUM(${aiUsageLogs.outputTokens})::int`,
        cachedTokens: sql<number>`SUM(${aiUsageLogs.cachedInputTokens})::int`,
        callCount: sql<number>`COUNT(*)::int`,
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.remediationSessionId, run.remediationId))
      .groupBy(aiUsageLogs.feature);

    if (breakdownRows.length === 0) {
      // No logs found — skip with passed=null. Auto-merge treats as skip.
      await db
        .update(costImpactRuns)
        .set({
          status: "completed",
          passed: null,
          error: "no-logs",
          completedAt: new Date(),
        })
        .where(eq(costImpactRuns.id, runId));
      return;
    }

    const breakdown: Record<string, CostFeatureBreakdown> = {};
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;
    let totalCalls = 0;

    for (const r of breakdownRows) {
      const cost = Number(r.costUsd);
      breakdown[r.feature] = {
        costUsd: Math.round(cost * 1_000_000) / 1_000_000,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        callCount: r.callCount,
      };
      totalCost += cost;
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      totalCached += r.cachedTokens;
      totalCalls += r.callCount;
    }

    const thresholdUsd = Number(run.thresholdUsd);
    const passed = totalCost <= thresholdUsd;

    await db
      .update(costImpactRuns)
      .set({
        status: "completed",
        remediationCostUsd: String(totalCost),
        tokenCountInput: totalInput,
        tokenCountOutput: totalOutput,
        tokenCountCached: totalCached,
        callCount: totalCalls,
        costBreakdown: breakdown,
        passed,
        completedAt: new Date(),
      })
      .where(eq(costImpactRuns.id, runId));
  } catch (err) {
    await db
      .update(costImpactRuns)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(costImpactRuns.id, runId));
  }
}

// ── Internals ────────────────────────────────────────────────────────────

async function readRun(id: string): Promise<CostImpactStatus | null> {
  const [row] = await db
    .select()
    .from(costImpactRuns)
    .where(eq(costImpactRuns.id, id))
    .limit(1);
  return row ? shape(row) : null;
}

function shape(row: CostImpactRun): CostImpactStatus {
  return {
    runId: row.id,
    status: row.status as CostImpactStatus["status"],
    remediationCostUsd: Number(row.remediationCostUsd),
    tokenCountInput: row.tokenCountInput,
    tokenCountOutput: row.tokenCountOutput,
    tokenCountCached: row.tokenCountCached,
    callCount: row.callCount,
    costBreakdown: (row.costBreakdown ?? {}) as Record<string, CostFeatureBreakdown>,
    thresholdUsd: Number(row.thresholdUsd),
    passed: row.passed,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    error: row.error,
  };
}
