/**
 * Performance Benchmark service — VAR Gate 17.
 *
 * Idempotent upsert into performance_benchmarks + enqueue the worker
 * job. Mirrors the shape of `what-if-fleet.ts` — same UNIQUE
 * (alert, remediation, sha) dedup, same "running → completed/failed"
 * state machine.
 */

import { db } from "@/lib/db";
import {
  performanceBenchmarks,
  type PerformanceBenchmark,
} from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";

export const DEFAULT_THRESHOLD_PERCENT = 10;

export interface PerformanceBenchmarkStatus {
  runId: string;
  status: "running" | "completed" | "failed";
  baselineP50Ms: number | null;
  baselineP99Ms: number | null;
  fixP50Ms: number | null;
  fixP99Ms: number | null;
  regressionPercent: number | null;
  thresholdPercent: number;
  passed: boolean | null;
  affectedPaths: AffectedPath[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface AffectedPath {
  url: string;
  method: string;
  baselineP50Ms: number;
  fixP50Ms: number;
  regressionPct: number;
  sampleSize: number;
  slowerThanThreshold: boolean;
}

export interface StartInput {
  alertId: string;
  remediationId: string;
  fixCommitSha: string;
  thresholdPercent?: number;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function startOrGetBenchmark(input: StartInput): Promise<{
  runId: string;
  created: boolean;
  status: PerformanceBenchmarkStatus;
}> {
  const [existing] = await db
    .select()
    .from(performanceBenchmarks)
    .where(
      and(
        eq(performanceBenchmarks.alertId, input.alertId),
        eq(performanceBenchmarks.remediationId, input.remediationId),
        eq(performanceBenchmarks.fixCommitSha, input.fixCommitSha),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.status === "failed") {
      await db
        .update(performanceBenchmarks)
        .set({
          status: "running",
          error: null,
          completedAt: null,
          startedAt: new Date(),
          baselineP50Ms: null,
          baselineP99Ms: null,
          fixP50Ms: null,
          fixP99Ms: null,
          regressionPercent: null,
          passed: null,
        })
        .where(eq(performanceBenchmarks.id, existing.id));
      await enqueue(existing.id, input.thresholdPercent);
    }
    const refreshed = await readRun(existing.id);
    if (!refreshed) throw new Error(`benchmark ${existing.id} vanished`);
    return { runId: existing.id, created: false, status: refreshed };
  }

  const [inserted] = await db
    .insert(performanceBenchmarks)
    .values({
      alertId: input.alertId,
      remediationId: input.remediationId,
      fixCommitSha: input.fixCommitSha,
      thresholdPercent: input.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT,
      status: "running",
    })
    .returning({ id: performanceBenchmarks.id });

  await enqueue(inserted.id, input.thresholdPercent);

  const status = await readRun(inserted.id);
  if (!status) throw new Error(`benchmark ${inserted.id} failed to insert`);
  return { runId: inserted.id, created: true, status };
}

export async function getBenchmarkForAlert(
  alertId: string,
): Promise<PerformanceBenchmarkStatus | null> {
  const [row] = await db
    .select()
    .from(performanceBenchmarks)
    .where(eq(performanceBenchmarks.alertId, alertId))
    .orderBy(desc(performanceBenchmarks.startedAt))
    .limit(1);
  return row ? shape(row) : null;
}

// ── Internals ─────────────────────────────────────────────────────────────

async function readRun(id: string): Promise<PerformanceBenchmarkStatus | null> {
  const [row] = await db
    .select()
    .from(performanceBenchmarks)
    .where(eq(performanceBenchmarks.id, id))
    .limit(1);
  return row ? shape(row) : null;
}

function shape(row: PerformanceBenchmark): PerformanceBenchmarkStatus {
  return {
    runId: row.id,
    status: row.status as "running" | "completed" | "failed",
    baselineP50Ms: row.baselineP50Ms,
    baselineP99Ms: row.baselineP99Ms,
    fixP50Ms: row.fixP50Ms,
    fixP99Ms: row.fixP99Ms,
    regressionPercent: row.regressionPercent,
    thresholdPercent: row.thresholdPercent,
    passed: row.passed,
    affectedPaths: Array.isArray(row.affectedPaths)
      ? (row.affectedPaths as AffectedPath[])
      : [],
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    error: row.error,
  };
}

async function enqueue(runId: string, thresholdPercent?: number): Promise<void> {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!workerUrl || !secret) {
    throw new Error("performance benchmark requires WORKER_URL + STAGING_API_SECRET");
  }
  const res = await fetch(`${workerUrl}/worker/enqueue`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      queue: "low",
      name: "performance-benchmark",
      data: { runId, thresholdPercent },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`enqueue performance-benchmark failed (${res.status}): ${body.slice(0, 200)}`);
  }
}
