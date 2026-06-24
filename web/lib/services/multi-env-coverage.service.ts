/**
 * Multi-Environment Coverage service — VAR Gate 16.
 *
 * Idempotent upsert into multi_env_coverage_runs + synchronous scoring
 * (no worker job). The scoring path is:
 *
 *   1. Locate the Gate 12 run for the same (alert, remediation, sha).
 *      If missing or still running → skip with "fleet-incomplete".
 *   2. Extract fleet session IDs from fleet_verification_runs.session_results.
 *   3. Compute project env distribution via env-distribution primitive
 *      (alerts.correlationData.env over N-day window).
 *   4. Compute fleet env distribution for those session IDs.
 *   5. Apply analyzeCoverage — returns pass/fail + missing envs classified
 *      by traffic-weighted severity.
 *
 * Skip outcomes (passed=null) follow the Gate 13/17 contract:
 *   - single-env        : project runs only one Node major (no diversity)
 *   - fleet-incomplete  : Gate 12 hasn't completed yet
 *   - no-project-data   : zero alerts with env in window (old SDK)
 *   - no-fleet-data     : Gate 12 completed but zero env data in replays
 *
 * Query cost: O(number of alerts in 30d window) — bounded, no aggregation
 * joins. Under 100ms on typical projects; if it grows we move to a worker
 * job without changing the contract (the SQL stays identical).
 */

import { db } from "@/lib/db";
import {
  alerts,
  fleetVerificationRuns,
  multiEnvCoverageRuns,
  type MultiEnvCoverageRun,
} from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
  analyzeCoverage,
  computeFleetEnvDistribution,
  computeProjectEnvDistribution,
  type EnvVector,
} from "./env-distribution.service";

export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_THRESHOLD_HIGH_PERCENT = 20;
export const DEFAULT_THRESHOLD_MEDIUM_PERCENT = 10;

// ── Public shapes ─────────────────────────────────────────────────────────

export interface MultiEnvStatus {
  runId: string;
  status: "running" | "completed" | "failed" | "skipped";
  windowDays: number;
  thresholdHighPercent: number;
  thresholdMediumPercent: number;
  projectEnvDistribution: Record<string, { trafficPercent: number; sessionCount: number }>;
  fleetEnvDistribution: Record<string, { trafficPercent: number; sessionCount: number }>;
  missingEnvsHigh: string[];
  missingEnvsMedium: string[];
  coveragePercent: number | null;
  observedEnvVectors: EnvVector[];
  passed: boolean | null;
  skipReason: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface StartInput {
  alertId: string;
  remediationId: string;
  fixCommitSha: string;
  windowDays?: number;
  thresholdHighPercent?: number;
  thresholdMediumPercent?: number;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function startOrGetMultiEnvRun(input: StartInput): Promise<{
  runId: string;
  created: boolean;
  status: MultiEnvStatus;
}> {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const thresholdHighPercent = input.thresholdHighPercent ?? DEFAULT_THRESHOLD_HIGH_PERCENT;
  const thresholdMediumPercent = input.thresholdMediumPercent ?? DEFAULT_THRESHOLD_MEDIUM_PERCENT;

  const [existing] = await db
    .select()
    .from(multiEnvCoverageRuns)
    .where(
      and(
        eq(multiEnvCoverageRuns.alertId, input.alertId),
        eq(multiEnvCoverageRuns.remediationId, input.remediationId),
        eq(multiEnvCoverageRuns.fixCommitSha, input.fixCommitSha),
      ),
    )
    .limit(1);

  if (existing && existing.status !== "failed") {
    const refreshed = await readRun(existing.id);
    if (!refreshed) throw new Error(`multi-env run ${existing.id} vanished`);
    return { runId: existing.id, created: false, status: refreshed };
  }

  // Either brand-new OR the previous attempt failed and we want a retry.
  let runId: string;
  if (existing) {
    await db
      .update(multiEnvCoverageRuns)
      .set({
        status: "running",
        error: null,
        completedAt: null,
        startedAt: new Date(),
        projectEnvDistribution: {},
        fleetEnvDistribution: {},
        missingEnvsHigh: [],
        missingEnvsMedium: [],
        coveragePercent: null,
        observedEnvVectors: [],
        passed: null,
        skipReason: null,
        windowDays,
        thresholdHighPercent: String(thresholdHighPercent),
        thresholdMediumPercent: String(thresholdMediumPercent),
      })
      .where(eq(multiEnvCoverageRuns.id, existing.id));
    runId = existing.id;
  } else {
    const [inserted] = await db
      .insert(multiEnvCoverageRuns)
      .values({
        alertId: input.alertId,
        remediationId: input.remediationId,
        fixCommitSha: input.fixCommitSha,
        windowDays,
        thresholdHighPercent: String(thresholdHighPercent),
        thresholdMediumPercent: String(thresholdMediumPercent),
        status: "running",
      })
      .returning({ id: multiEnvCoverageRuns.id });
    runId = inserted.id;
  }

  // Synchronous scoring — the query is cheap enough to run inline.
  await scoreAndPersist(runId);

  const status = await readRun(runId);
  if (!status) throw new Error(`multi-env run ${runId} failed to insert`);
  return { runId, created: !existing, status };
}

export async function getMultiEnvRunForAlert(
  alertId: string,
): Promise<MultiEnvStatus | null> {
  const [row] = await db
    .select()
    .from(multiEnvCoverageRuns)
    .where(eq(multiEnvCoverageRuns.alertId, alertId))
    .orderBy(desc(multiEnvCoverageRuns.startedAt))
    .limit(1);
  return row ? shape(row) : null;
}

// ── Scoring pipeline ──────────────────────────────────────────────────────

async function scoreAndPersist(runId: string): Promise<void> {
  try {
    // Reload the running row to get its config + alertId for the joins.
    const [run] = await db
      .select()
      .from(multiEnvCoverageRuns)
      .where(eq(multiEnvCoverageRuns.id, runId))
      .limit(1);
    if (!run) return;

    // Find the alert's project so distribution queries are scoped correctly.
    const [alert] = await db
      .select({ projectId: alerts.projectId })
      .from(alerts)
      .where(eq(alerts.id, run.alertId))
      .limit(1);
    if (!alert) {
      await failRun(runId, "alert-not-found");
      return;
    }

    // Look up the Gate 12 run for the same (alert, remediation, sha).
    const [fleetRun] = await db
      .select()
      .from(fleetVerificationRuns)
      .where(
        and(
          eq(fleetVerificationRuns.alertId, run.alertId),
          eq(fleetVerificationRuns.remediationId, run.remediationId),
          eq(fleetVerificationRuns.fixCommitSha, run.fixCommitSha),
        ),
      )
      .limit(1);

    if (!fleetRun || fleetRun.status !== "completed") {
      await skipRun(runId, "fleet-incomplete");
      return;
    }

    // session_results is [{ sessionId, outcome, ... }] — extract the IDs.
    const sessionResults = Array.isArray(fleetRun.sessionResults)
      ? (fleetRun.sessionResults as Array<{ sessionId?: string }>)
      : [];
    const sessionIds = sessionResults
      .map((s) => s.sessionId)
      .filter((s): s is string => typeof s === "string");

    // Compute distributions via the shared primitive.
    const projectDist = await computeProjectEnvDistribution({
      projectId: alert.projectId,
      windowDays: run.windowDays,
    });
    const fleetDist = await computeFleetEnvDistribution({
      projectId: alert.projectId,
      sessionIds,
    });

    const thresholds = {
      highPercent: Number(run.thresholdHighPercent),
      mediumPercent: Number(run.thresholdMediumPercent),
    };
    const analysis = analyzeCoverage(projectDist, fleetDist, thresholds);

    if (!analysis.applicable) {
      await skipRun(runId, analysis.skipReason ?? "unknown", {
        projectEnvDistribution: projectDist.distribution,
        fleetEnvDistribution: fleetDist.distribution,
        observedEnvVectors: fleetDist.vectors,
      });
      return;
    }

    // Applicable — pass/fail on HIGH severity misses.
    const passed = analysis.missingEnvsHigh.length === 0;
    await db
      .update(multiEnvCoverageRuns)
      .set({
        status: "completed",
        projectEnvDistribution: projectDist.distribution,
        fleetEnvDistribution: fleetDist.distribution,
        missingEnvsHigh: analysis.missingEnvsHigh,
        missingEnvsMedium: analysis.missingEnvsMedium,
        coveragePercent: String(analysis.coveragePercent),
        observedEnvVectors: fleetDist.vectors,
        passed,
        completedAt: new Date(),
      })
      .where(eq(multiEnvCoverageRuns.id, runId));
  } catch (err) {
    await failRun(runId, err instanceof Error ? err.message : String(err));
  }
}

async function failRun(runId: string, reason: string): Promise<void> {
  await db
    .update(multiEnvCoverageRuns)
    .set({ status: "failed", error: reason, completedAt: new Date() })
    .where(eq(multiEnvCoverageRuns.id, runId));
}

async function skipRun(
  runId: string,
  reason: string,
  extra?: {
    projectEnvDistribution?: Record<string, { trafficPercent: number; sessionCount: number }>;
    fleetEnvDistribution?: Record<string, { trafficPercent: number; sessionCount: number }>;
    observedEnvVectors?: EnvVector[];
  },
): Promise<void> {
  await db
    .update(multiEnvCoverageRuns)
    .set({
      status: "skipped",
      skipReason: reason,
      passed: null,
      completedAt: new Date(),
      ...(extra?.projectEnvDistribution ? { projectEnvDistribution: extra.projectEnvDistribution } : {}),
      ...(extra?.fleetEnvDistribution ? { fleetEnvDistribution: extra.fleetEnvDistribution } : {}),
      ...(extra?.observedEnvVectors ? { observedEnvVectors: extra.observedEnvVectors } : {}),
    })
    .where(eq(multiEnvCoverageRuns.id, runId));
}

// ── Internals ─────────────────────────────────────────────────────────────

async function readRun(id: string): Promise<MultiEnvStatus | null> {
  const [row] = await db
    .select()
    .from(multiEnvCoverageRuns)
    .where(eq(multiEnvCoverageRuns.id, id))
    .limit(1);
  return row ? shape(row) : null;
}

function shape(row: MultiEnvCoverageRun): MultiEnvStatus {
  return {
    runId: row.id,
    status: row.status as MultiEnvStatus["status"],
    windowDays: row.windowDays,
    thresholdHighPercent: Number(row.thresholdHighPercent),
    thresholdMediumPercent: Number(row.thresholdMediumPercent),
    projectEnvDistribution: (row.projectEnvDistribution ?? {}) as MultiEnvStatus["projectEnvDistribution"],
    fleetEnvDistribution: (row.fleetEnvDistribution ?? {}) as MultiEnvStatus["fleetEnvDistribution"],
    missingEnvsHigh: row.missingEnvsHigh ?? [],
    missingEnvsMedium: row.missingEnvsMedium ?? [],
    coveragePercent: row.coveragePercent != null ? Number(row.coveragePercent) : null,
    observedEnvVectors: Array.isArray(row.observedEnvVectors)
      ? (row.observedEnvVectors as EnvVector[])
      : [],
    passed: row.passed,
    skipReason: row.skipReason,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    error: row.error,
  };
}
