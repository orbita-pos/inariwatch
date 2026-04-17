/**
 * Behavioral Drift service — VAR Gate 13.
 *
 * Idempotent upsert into behavioral_drift_runs + enqueue the worker job.
 * Mirrors the shape of performance-benchmark.service.ts — same UNIQUE
 * (alert, remediation, sha) dedup, same "running → completed/failed"
 * state machine, same worker enqueue pattern.
 *
 * The actual drift scoring (baseline percentile query, magnitude delta,
 * structural set-diff, permissive pass/fail) lives in
 * worker/src/jobs/behavioral-drift.ts — this service only coordinates.
 */

import { db } from "@/lib/db";
import {
  behavioralDriftRuns,
  type BehavioralDriftRun,
} from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_THRESHOLD_DRIFTED_PERCENT = 20;

// ── Public shapes ─────────────────────────────────────────────────────────

/** Per-metric delta emitted by the worker scoring pass. */
export interface MetricDelta {
  baselineP95: number | null;
  fixP95: number | null;
  deltaPct: number | null;
  flagged: boolean;
}

/** Structural drift signals — set-diff on downstreams, status category. */
export interface StructuralDrift {
  missingDownstreams: string[];
  newDownstreams: string[];
  statusShift: {
    baseline5xxRatio: number;
    fix5xxRatio: number;
  } | null;
}

/** One entry in endpointDetails / improvementsDetected. */
export interface EndpointDrift {
  signature: string;
  magnitudeScore: number;
  hasStructuralDrift: boolean;
  baselineSamples: number;
  fixSamples: number;
  structural: StructuralDrift;
  magnitude: {
    latencyMs: MetricDelta;
    dbQueryCount: MetricDelta;
    externalHttpCount: MetricDelta;
  };
}

export interface BehavioralDriftStatus {
  runId: string;
  status: "running" | "completed" | "failed";
  windowDays: number;
  analyzedEndpoints: number;
  insufficientDataEndpoints: number;
  driftedEndpoints: number;
  improvedEndpoints: number;
  maxDriftScore: number | null;
  thresholdDriftedPercent: number;
  passed: boolean | null;
  endpointDetails: EndpointDrift[];
  improvementsDetected: EndpointDrift[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface StartInput {
  alertId: string;
  remediationId: string;
  fixCommitSha: string;
  /** Rolling baseline window in days. Default 7. */
  windowDays?: number;
  /** Percent of analyzed endpoints that must drift to fail the gate.
   *  Default 20. Permissive calibration — only this threshold drives
   *  pass/fail, structural drift does not dominate. */
  thresholdDriftedPercent?: number;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function startOrGetDriftRun(input: StartInput): Promise<{
  runId: string;
  created: boolean;
  status: BehavioralDriftStatus;
}> {
  const [existing] = await db
    .select()
    .from(behavioralDriftRuns)
    .where(
      and(
        eq(behavioralDriftRuns.alertId, input.alertId),
        eq(behavioralDriftRuns.remediationId, input.remediationId),
        eq(behavioralDriftRuns.fixCommitSha, input.fixCommitSha),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.status === "failed") {
      // Reset for re-run — same shape as Gate 17's retry path.
      await db
        .update(behavioralDriftRuns)
        .set({
          status: "running",
          error: null,
          completedAt: null,
          startedAt: new Date(),
          analyzedEndpoints: 0,
          insufficientDataEndpoints: 0,
          driftedEndpoints: 0,
          improvedEndpoints: 0,
          maxDriftScore: null,
          endpointDetails: [],
          improvementsDetected: [],
          passed: null,
        })
        .where(eq(behavioralDriftRuns.id, existing.id));
      await enqueueDriftJob(existing.id);
    }
    const refreshed = await readRun(existing.id);
    if (!refreshed) throw new Error(`drift run ${existing.id} vanished`);
    return { runId: existing.id, created: false, status: refreshed };
  }

  const [inserted] = await db
    .insert(behavioralDriftRuns)
    .values({
      alertId: input.alertId,
      remediationId: input.remediationId,
      fixCommitSha: input.fixCommitSha,
      windowDays: input.windowDays ?? DEFAULT_WINDOW_DAYS,
      thresholdDriftedPercent:
        input.thresholdDriftedPercent ?? DEFAULT_THRESHOLD_DRIFTED_PERCENT,
      status: "running",
    })
    .returning({ id: behavioralDriftRuns.id });

  await enqueueDriftJob(inserted.id);

  const status = await readRun(inserted.id);
  if (!status) throw new Error(`drift run ${inserted.id} failed to insert`);
  return { runId: inserted.id, created: true, status };
}

export async function getDriftRunForAlert(
  alertId: string,
): Promise<BehavioralDriftStatus | null> {
  const [row] = await db
    .select()
    .from(behavioralDriftRuns)
    .where(eq(behavioralDriftRuns.alertId, alertId))
    .orderBy(desc(behavioralDriftRuns.startedAt))
    .limit(1);
  return row ? shape(row) : null;
}

// ── Internals ─────────────────────────────────────────────────────────────

async function readRun(id: string): Promise<BehavioralDriftStatus | null> {
  const [row] = await db
    .select()
    .from(behavioralDriftRuns)
    .where(eq(behavioralDriftRuns.id, id))
    .limit(1);
  return row ? shape(row) : null;
}

function shape(row: BehavioralDriftRun): BehavioralDriftStatus {
  return {
    runId: row.id,
    status: row.status as "running" | "completed" | "failed",
    windowDays: row.windowDays,
    analyzedEndpoints: row.analyzedEndpoints,
    insufficientDataEndpoints: row.insufficientDataEndpoints,
    driftedEndpoints: row.driftedEndpoints,
    improvedEndpoints: row.improvedEndpoints,
    maxDriftScore: row.maxDriftScore,
    thresholdDriftedPercent: row.thresholdDriftedPercent,
    passed: row.passed,
    endpointDetails: Array.isArray(row.endpointDetails)
      ? (row.endpointDetails as EndpointDrift[])
      : [],
    improvementsDetected: Array.isArray(row.improvementsDetected)
      ? (row.improvementsDetected as EndpointDrift[])
      : [],
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    error: row.error,
  };
}

async function enqueueDriftJob(runId: string): Promise<void> {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!workerUrl || !secret) {
    throw new Error("behavioral drift requires WORKER_URL + STAGING_API_SECRET");
  }
  const res = await fetch(`${workerUrl}/worker/enqueue`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      queue: "low",
      name: "behavioral-drift",
      data: { runId },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`enqueue behavioral-drift failed (${res.status}): ${body.slice(0, 200)}`);
  }
}
