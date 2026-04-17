/**
 * What-If Across Fleet service — VAR Gate 12.
 *
 * Orchestrates a batched What-If replay against the top N sessions
 * sharing an alert's fingerprint. The heavy lifting (cloning repo,
 * running substrate) happens in the worker's `fleet-verification`
 * BullMQ job; this service only:
 *
 *   1. Reads/creates the `fleet_verification_runs` row
 *   2. Enqueues the worker job when needed
 *   3. Returns current status for polling clients
 *
 * Contract with the UI:
 *   - POST /api/alerts/:id/fleet-verify → status + runId (202 if new,
 *     200 if existing completed/running)
 *   - GET  /api/alerts/:id/fleet-verify → latest run shape, to poll
 *
 * Authz happens in the route, not here.
 */

import { db } from "@/lib/db";
import {
  alerts,
  fleetVerificationRuns,
  remediationSessions,
  replaySessions,
  substrateRecordings,
  type FleetVerificationRun,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

// ── Constants ─────────────────────────────────────────────────────────────

/** Shared with the worker side — keep in sync. */
const DEFAULT_MAX_SESSIONS = 100;

/** Auto-merge threshold: Gate 12 requires this % of sessions to be in
 *  `matched` (would_prevent) for autonomous merges. Exposed so the
 *  auto-merge gate code reads one source of truth. */
export const FLEET_PASS_THRESHOLD_PERCENT = 90;

export interface FleetVerificationStatus {
  runId: string;
  status: "running" | "completed" | "failed";
  sessionsAttempted: number;
  sessionsTotal: number;
  countMatched: number;
  countUncertain: number;
  countWouldNotPrevent: number;
  countErrored: number;
  matchedPercent: number | null;
  passesThreshold: boolean;
  sessionResults: SessionResultSummary[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface SessionResultSummary {
  sessionId: string;
  outcome: "matched" | "uncertain" | "would_not_prevent" | "errored";
  riskScore?: number;
  errorCode?: string;
  durationMs: number;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface StartFleetInput {
  alertId: string;
  remediationId: string;
  fixCommitSha: string;
  fingerprint: string;
  githubToken?: string;
}

/**
 * Idempotent. Returns either an existing run (any status) or creates a
 * fresh one and enqueues the worker job. Returns the runId in both cases.
 *
 * The `created` flag lets the caller set 202 vs 200 on the HTTP response.
 */
export async function startOrGetFleetRun(input: StartFleetInput): Promise<
  { runId: string; created: boolean; status: FleetVerificationStatus }
> {
  // Idempotency via UNIQUE (alert_id, remediation_id, fix_commit_sha).
  const [existing] = await db
    .select()
    .from(fleetVerificationRuns)
    .where(
      and(
        eq(fleetVerificationRuns.alertId, input.alertId),
        eq(fleetVerificationRuns.remediationId, input.remediationId),
        eq(fleetVerificationRuns.fixCommitSha, input.fixCommitSha),
      ),
    )
    .limit(1);

  if (existing) {
    // If it failed cleanly (retryable), re-enqueue. Otherwise return as-is.
    if (existing.status === "failed") {
      await db
        .update(fleetVerificationRuns)
        .set({
          status: "running",
          sessionsAttempted: 0,
          countMatched: 0,
          countUncertain: 0,
          countWouldNotPrevent: 0,
          countErrored: 0,
          sessionResults: sql`'[]'::jsonb`,
          error: null,
          completedAt: null,
          startedAt: new Date(),
        })
        .where(eq(fleetVerificationRuns.id, existing.id));
      await enqueueFleetJob(existing.id, input.githubToken);
    }

    const refreshed = await readRun(existing.id);
    if (!refreshed) {
      throw new Error(`fleet run ${existing.id} vanished after re-enqueue`);
    }
    return { runId: existing.id, created: false, status: refreshed };
  }

  // Pre-count candidates so the initial `sessions_total` is realistic.
  // The worker will refresh this after its own filter pass, but an
  // estimate here makes the UI's progress bar behave even for the first
  // second before the job starts.
  const candidateCount = await countCandidateSessions({
    alertId: input.alertId,
    fingerprint: input.fingerprint,
  });

  const [inserted] = await db
    .insert(fleetVerificationRuns)
    .values({
      alertId: input.alertId,
      remediationId: input.remediationId,
      fixCommitSha: input.fixCommitSha,
      fingerprint: input.fingerprint,
      status: "running",
      sessionsTotal: candidateCount,
    })
    .returning({ id: fleetVerificationRuns.id });

  const runId = inserted.id;
  await enqueueFleetJob(runId, input.githubToken);

  const status = await readRun(runId);
  if (!status) throw new Error(`fleet run ${runId} failed to insert`);
  return { runId, created: true, status };
}

/** Pure status read — the polling path. Returns null when the run
 *  doesn't exist (UI should treat as "never ran"). */
export async function getFleetRunForAlert(
  alertId: string,
): Promise<FleetVerificationStatus | null> {
  const [row] = await db
    .select()
    .from(fleetVerificationRuns)
    .where(eq(fleetVerificationRuns.alertId, alertId))
    .orderBy(desc(fleetVerificationRuns.startedAt))
    .limit(1);

  if (!row) return null;
  return shapeStatus(row);
}

// ── Internals ─────────────────────────────────────────────────────────────

async function readRun(id: string): Promise<FleetVerificationStatus | null> {
  const [row] = await db
    .select()
    .from(fleetVerificationRuns)
    .where(eq(fleetVerificationRuns.id, id))
    .limit(1);
  return row ? shapeStatus(row) : null;
}

function shapeStatus(row: FleetVerificationRun): FleetVerificationStatus {
  const total = row.sessionsTotal;
  const matchedPercent = total > 0 ? Math.round((row.countMatched / total) * 100) : null;
  const passesThreshold = matchedPercent !== null && matchedPercent >= FLEET_PASS_THRESHOLD_PERCENT;
  const sessionResults = Array.isArray(row.sessionResults)
    ? (row.sessionResults as SessionResultSummary[])
    : [];

  return {
    runId: row.id,
    status: row.status as "running" | "completed" | "failed",
    sessionsAttempted: row.sessionsAttempted,
    sessionsTotal: total,
    countMatched: row.countMatched,
    countUncertain: row.countUncertain,
    countWouldNotPrevent: row.countWouldNotPrevent,
    countErrored: row.countErrored,
    matchedPercent,
    passesThreshold,
    sessionResults,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    error: row.error,
  };
}

async function countCandidateSessions({
  alertId,
  fingerprint,
}: {
  alertId: string;
  fingerprint: string;
}): Promise<number> {
  const [alert] = await db
    .select({ projectId: alerts.projectId, sessionId: alerts.sessionId })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return 0;

  // Matches the worker's pickCandidateSessions query: we count replay
  // sessions whose error_fingerprints array contains the fingerprint.
  // alerts.fingerprint is deduped (1 alert per fingerprint) so querying
  // alerts would always return count=1 regardless of real fleet size.
  const related = await db
    .select({ sessionId: replaySessions.sessionId })
    .from(replaySessions)
    .where(
      and(
        eq(replaySessions.projectId, alert.projectId),
        sql`${replaySessions.errorFingerprints} @> ARRAY[${fingerprint}]::text[]`,
      ),
    )
    .limit(DEFAULT_MAX_SESSIONS * 2);

  const seen = new Set<string>();
  for (const r of related) {
    if (r.sessionId && r.sessionId !== alert.sessionId) seen.add(r.sessionId);
  }
  if (seen.size === 0) return 0;

  const sessionIds = Array.from(seen).slice(0, DEFAULT_MAX_SESSIONS);
  const withRecording = await db
    .select({ sessionId: substrateRecordings.sessionId })
    .from(substrateRecordings)
    .where(
      and(
        inArray(substrateRecordings.sessionId, sessionIds),
        isNotNull(substrateRecordings.sessionId),
      ),
    );

  const recordable = new Set(
    withRecording.map((r) => r.sessionId).filter((s): s is string => !!s),
  );
  return sessionIds.filter((s) => recordable.has(s)).length;
}

/**
 * Enqueue the worker job. Uses the existing worker HTTP API at
 * $WORKER_URL/worker/enqueue — the same pattern BullMQ uses for other
 * web→worker job dispatch.
 *
 * Silent-fail behavior: if the worker is unreachable we leave the row
 * in 'running' state. A separate health check (future) can sweep stuck
 * rows. For now, failing to enqueue throws — the caller sees a 500 and
 * the row gets cleaned up by the worker's health loop.
 */
async function enqueueFleetJob(runId: string, githubToken?: string): Promise<void> {
  const workerUrl = process.env.WORKER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!workerUrl || !secret) {
    throw new Error("fleet verification requires WORKER_URL + STAGING_API_SECRET");
  }

  const res = await fetch(`${workerUrl}/worker/enqueue`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      queue: "low",
      name: "fleet-verification",
      data: { runId, githubToken },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`enqueue fleet-verification failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const { jobId } = (await res.json()) as { jobId?: string };
  if (jobId) {
    await db
      .update(fleetVerificationRuns)
      .set({ bullmqJobId: jobId })
      .where(eq(fleetVerificationRuns.id, runId));
  }
}
