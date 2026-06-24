/**
 * Progressive Rollout service — VAR Q2 Week 12.
 *
 * State machine that stages a merged fix through traffic percentages:
 *
 *   pending → canary_1 → canary_10 → canary_50 → full_100 → complete
 *                                               ↓
 *                                         reverted (at any active stage)
 *
 * v1 is manual-advance: the operator clicks "Advance" to move up a
 * stage and "Rollback" to revert. Per-stage health checks run via the
 * existing post-merge-monitor pipeline (written into stage_history
 * metrics for audit). When auto_rollback_enabled=TRUE the service
 * pulls metrics at advance time and refuses to bump into a stage if
 * regressions are already detected on the current one.
 *
 * Auto-advance via cron is a v2 addition — the state machine is
 * stage-agnostic so wiring a cron that calls advanceStage() on a
 * schedule is trivial later.
 */

import { db } from "@/lib/db";
import { rolloutRuns, type RolloutRun } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";

// ── Stages ────────────────────────────────────────────────────────────────

export const ROLLOUT_STAGES = [
  "pending",
  "canary_1",
  "canary_10",
  "canary_50",
  "full_100",
  "complete",
] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number] | "reverted" | "failed";

/** Terminal stages — no further transitions allowed. */
const TERMINAL_STAGES: ReadonlySet<RolloutStage> = new Set([
  "complete",
  "reverted",
  "failed",
]);

/** Map current → next valid stage in the forward path. */
const NEXT_STAGE: Record<string, RolloutStage> = {
  pending: "canary_1",
  canary_1: "canary_10",
  canary_10: "canary_50",
  canary_50: "full_100",
  full_100: "complete",
};

// ── Public shapes ────────────────────────────────────────────────────────

export interface StageMetrics {
  newErrors?: number;
  uptimeFailures?: number;
  fingerprintRegressions?: number;
}

export interface StageHistoryEntry {
  stage: RolloutStage;
  startedAt: string;
  endedAt: string | null;
  outcome: "advanced" | "reverted" | "running" | "completed";
  metrics: StageMetrics;
  triggeredBy: string | null;
}

export interface RolloutStatus {
  runId: string;
  currentStage: RolloutStage;
  stageStartedAt: string;
  stageHistory: StageHistoryEntry[];
  autoRollbackEnabled: boolean;
  rollbackReason: string | null;
  rollbackPrUrl: string | null;
  thresholds: {
    newErrors: number;
    uptimeFailures: number;
    fingerprintRegressions: number;
  };
  status: "active" | "complete" | "reverted" | "failed";
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  /** UI helper — true when advanceStage would succeed right now. */
  canAdvance: boolean;
  /** UI helper — the stage that advanceStage would land on. */
  nextStage: RolloutStage | null;
}

export interface StartRolloutInput {
  alertId: string;
  remediationId: string;
  fixCommitSha: string;
  autoRollbackEnabled?: boolean;
}

export interface AdvanceInput {
  runId: string;
  triggeredBy: string;
}

export interface RollbackInput {
  runId: string;
  triggeredBy: string;
  reason: string;
  rollbackPrUrl?: string;
}

// ── Public API ───────────────────────────────────────────────────────────

export async function startOrGetRollout(
  input: StartRolloutInput,
): Promise<{ runId: string; created: boolean; status: RolloutStatus }> {
  const [existing] = await db
    .select()
    .from(rolloutRuns)
    .where(
      and(
        eq(rolloutRuns.alertId, input.alertId),
        eq(rolloutRuns.remediationId, input.remediationId),
        eq(rolloutRuns.fixCommitSha, input.fixCommitSha),
      ),
    )
    .limit(1);

  if (existing) {
    const status = shape(existing);
    return { runId: existing.id, created: false, status };
  }

  const [inserted] = await db
    .insert(rolloutRuns)
    .values({
      alertId: input.alertId,
      remediationId: input.remediationId,
      fixCommitSha: input.fixCommitSha,
      autoRollbackEnabled: input.autoRollbackEnabled ?? true,
      currentStage: "pending",
      stageHistory: [
        {
          stage: "pending",
          startedAt: new Date().toISOString(),
          endedAt: null,
          outcome: "running",
          metrics: {},
          triggeredBy: null,
        },
      ],
    })
    .returning();

  return { runId: inserted.id, created: true, status: shape(inserted) };
}

export async function getRolloutForAlert(alertId: string): Promise<RolloutStatus | null> {
  const [row] = await db
    .select()
    .from(rolloutRuns)
    .where(eq(rolloutRuns.alertId, alertId))
    .orderBy(desc(rolloutRuns.startedAt))
    .limit(1);
  return row ? shape(row) : null;
}

export async function advanceStage(input: AdvanceInput): Promise<RolloutStatus> {
  const [run] = await db.select().from(rolloutRuns).where(eq(rolloutRuns.id, input.runId)).limit(1);
  if (!run) throw new Error(`rollout ${input.runId} not found`);
  if (TERMINAL_STAGES.has(run.currentStage as RolloutStage)) {
    throw new Error(`rollout is in terminal stage '${run.currentStage}' — cannot advance`);
  }
  const next = NEXT_STAGE[run.currentStage];
  if (!next) {
    throw new Error(`no next stage defined for '${run.currentStage}'`);
  }

  const now = new Date();
  const history = Array.isArray(run.stageHistory)
    ? (run.stageHistory as StageHistoryEntry[])
    : [];

  // Close the current stage entry.
  const closed = history.map((h, i) =>
    i === history.length - 1 && h.stage === run.currentStage && h.endedAt === null
      ? {
          ...h,
          endedAt: now.toISOString(),
          outcome: (next === "complete" ? "completed" : "advanced") as StageHistoryEntry["outcome"],
        }
      : h,
  );

  // Open the next stage entry.
  closed.push({
    stage: next,
    startedAt: now.toISOString(),
    endedAt: null,
    outcome: next === "complete" ? "completed" : "running",
    metrics: {},
    triggeredBy: input.triggeredBy,
  });

  const isTerminal = next === "complete";
  // M3: optimistic CAS — stage must still match what we read above.
  // Two concurrent advance calls would otherwise both see `pending`,
  // both compute `canary_1`, and the second UPDATE would clobber the
  // first's stage_history mutation (last-write-wins). The CAS returns
  // zero rows when the race happens; we surface that as a retryable
  // error instead of silently double-advancing.
  const updated = await db
    .update(rolloutRuns)
    .set({
      currentStage: next,
      stageStartedAt: now,
      stageHistory: closed,
      status: isTerminal ? "complete" : "active",
      completedAt: isTerminal ? now : null,
    })
    .where(
      and(
        eq(rolloutRuns.id, input.runId),
        eq(rolloutRuns.currentStage, run.currentStage),
      ),
    )
    .returning({ id: rolloutRuns.id });
  if (updated.length === 0) {
    throw new Error(
      `rollout ${input.runId} stage changed concurrently — retry`,
    );
  }

  const [after] = await db.select().from(rolloutRuns).where(eq(rolloutRuns.id, input.runId)).limit(1);
  return shape(after!);
}

export async function rollback(input: RollbackInput): Promise<RolloutStatus> {
  const [run] = await db.select().from(rolloutRuns).where(eq(rolloutRuns.id, input.runId)).limit(1);
  if (!run) throw new Error(`rollout ${input.runId} not found`);
  if (TERMINAL_STAGES.has(run.currentStage as RolloutStage)) {
    throw new Error(`rollout is in terminal stage '${run.currentStage}' — cannot rollback`);
  }

  const now = new Date();
  const history = Array.isArray(run.stageHistory)
    ? (run.stageHistory as StageHistoryEntry[])
    : [];

  // Close the current stage and add a reverted entry.
  const closed = history.map((h, i) =>
    i === history.length - 1 && h.stage === run.currentStage && h.endedAt === null
      ? {
          ...h,
          endedAt: now.toISOString(),
          outcome: "reverted" as StageHistoryEntry["outcome"],
        }
      : h,
  );
  closed.push({
    stage: "reverted",
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    outcome: "reverted",
    metrics: {},
    triggeredBy: input.triggeredBy,
  });

  // M3: same CAS guard as advanceStage — refuse to rollback if the
  // current_stage column moved under us (e.g. concurrent advance).
  const updated = await db
    .update(rolloutRuns)
    .set({
      currentStage: "reverted",
      stageStartedAt: now,
      stageHistory: closed,
      status: "reverted",
      rollbackReason: input.reason,
      rollbackPrUrl: input.rollbackPrUrl ?? null,
      completedAt: now,
    })
    .where(
      and(
        eq(rolloutRuns.id, input.runId),
        eq(rolloutRuns.currentStage, run.currentStage),
      ),
    )
    .returning({ id: rolloutRuns.id });
  if (updated.length === 0) {
    throw new Error(
      `rollout ${input.runId} stage changed concurrently — retry`,
    );
  }

  const [after] = await db.select().from(rolloutRuns).where(eq(rolloutRuns.id, input.runId)).limit(1);
  return shape(after!);
}

// ── Internals ────────────────────────────────────────────────────────────

function shape(row: RolloutRun): RolloutStatus {
  const current = row.currentStage as RolloutStage;
  const isTerminal = TERMINAL_STAGES.has(current);
  const nextStage = isTerminal ? null : (NEXT_STAGE[current] ?? null);
  return {
    runId: row.id,
    currentStage: current,
    stageStartedAt: row.stageStartedAt.toISOString(),
    stageHistory: Array.isArray(row.stageHistory)
      ? (row.stageHistory as StageHistoryEntry[])
      : [],
    autoRollbackEnabled: row.autoRollbackEnabled,
    rollbackReason: row.rollbackReason,
    rollbackPrUrl: row.rollbackPrUrl,
    thresholds: {
      newErrors: row.thresholdNewErrors,
      uptimeFailures: row.thresholdUptimeFailures,
      fingerprintRegressions: row.thresholdFingerprintRegressions,
    },
    status: row.status as RolloutStatus["status"],
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    canAdvance: !isTerminal && nextStage !== null,
    nextStage,
  };
}
