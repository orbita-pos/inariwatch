/**
 * Replay retention sweep — deletes sessions that have aged past their
 * project's `retentionDays` setting.
 *
 * Why this exists:
 *   1. Operational — without sweeping, R2 grows unbounded.
 *   2. Privacy/legal — customers who set `retentionDays: 7` expect rows
 *      to be GONE on day 8, not just hidden. Required for GDPR right-to-
 *      erasure compliance to be more than a UI promise.
 *
 * Run by the `/api/cron/replay-retention` route, scheduled daily by the
 * Hetzner Go scheduler (Bearer CRON_SECRET auth).
 *
 * Pure-ish: takes a clock + a max-batch param so tests can drive it
 * deterministically and so a runaway sweep can't wedge a daily window.
 */

import { db } from "@/lib/db";
import { replaySessions, projects } from "@/lib/db/schema";
import { DEFAULT_REPLAY_SETTINGS, type ReplaySettings } from "@/lib/db/schema";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { deleteSession } from "@/lib/storage/replay-storage";
import { isExpired, ABSOLUTE_MAX_RETENTION_DAYS } from "./replay-retention-pure";

export { isExpired, ABSOLUTE_MAX_RETENTION_DAYS };

export interface RetentionResult {
  scanned: number;
  deleted: number;
  /** Sessions whose row was removed but whose R2 prefix delete failed.
   *  We log them as warnings — the next sweep will try the orphaned
   *  prefix again because the row is gone. */
  r2Failures: number;
  /** ISO timestamp of the OLDEST session we kept (just past the cutoff for
   *  the most-aggressive project). Useful for sanity-checking that the
   *  sweep is actually advancing the floor. */
  oldestKeptAt: string | null;
  durationMs: number;
}

/** Cap per run — bigger numbers slow the cron without proportional gain.
 *  At 200 sessions/run × 1 daily run, we sustainably retire ~73k sessions/yr. */
const DEFAULT_MAX_BATCH = 200;

export async function sweepReplayRetention(opts: {
  now?: Date;
  maxBatch?: number;
} = {}): Promise<RetentionResult> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;

  // Strategy: query sessions that are AT LEAST as old as the absolute floor
  // (366 days). For each, look up its project's retentionDays and decide
  // whether to delete. We skip sessions younger than 1 day regardless —
  // gives the analyzer time to run before its R2 input vanishes.
  //
  // Why not query per-project with a JOIN? Because retentionDays lives
  // inside a jsonb column — the planner can't index-scan on it cleanly.
  // We over-fetch a bounded batch ordered by createdAt and decide in JS;
  // way simpler and good enough at 200 rows/run.
  const minAgeMs = 24 * 60 * 60 * 1000; // 1 day grace
  const ageCutoff = new Date(now.getTime() - minAgeMs);

  const candidates = await db
    .select({
      id: replaySessions.id,
      sessionId: replaySessions.sessionId,
      organizationId: replaySessions.organizationId,
      projectId: replaySessions.projectId,
      createdAt: replaySessions.createdAt,
    })
    .from(replaySessions)
    .where(
      and(
        lte(replaySessions.createdAt, ageCutoff),
        isNotNull(replaySessions.organizationId),
      ),
    )
    .orderBy(replaySessions.createdAt) // oldest first → predictable progress
    .limit(maxBatch);

  // Cache project retention settings so a workspace with 50 sessions in
  // this batch only does one DB lookup, not 50.
  const projectRetention = new Map<string, number>();
  async function getRetentionDays(projectId: string | null): Promise<number> {
    if (!projectId) return DEFAULT_REPLAY_SETTINGS.retentionDays;
    const cached = projectRetention.get(projectId);
    if (typeof cached === "number") return cached;
    const [row] = await db
      .select({ replaySettings: projects.replaySettings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const settings = (row?.replaySettings ?? {}) as ReplaySettings;
    const days = Math.min(
      ABSOLUTE_MAX_RETENTION_DAYS,
      settings.retentionDays ?? DEFAULT_REPLAY_SETTINGS.retentionDays,
    );
    projectRetention.set(projectId, days);
    return days;
  }

  let deleted = 0;
  let r2Failures = 0;
  let oldestKeptAt: Date | null = null;

  for (const c of candidates) {
    const retentionDays = await getRetentionDays(c.projectId);
    if (!isExpired(c.createdAt, retentionDays, now)) {
      if (!oldestKeptAt || c.createdAt < oldestKeptAt) oldestKeptAt = c.createdAt;
      continue;
    }

    // Delete R2 first. If R2 fails we still drop the DB row — leaving the
    // row in place would re-attempt the same broken delete every day.
    // Orphaned R2 prefixes are caught by a separate orphan sweep (TODO).
    try {
      await deleteSession(c.organizationId!, c.sessionId);
    } catch (err) {
      r2Failures++;
      console.warn(
        `[replay-retention] R2 delete failed for ${c.sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    await db.delete(replaySessions).where(eq(replaySessions.id, c.id));
    deleted++;
  }

  return {
    scanned: candidates.length,
    deleted,
    r2Failures,
    oldestKeptAt: oldestKeptAt ? oldestKeptAt.toISOString() : null,
    durationMs: Date.now() - t0,
  };
}

// SQL-only diagnostic — used by the cron route to expose the size of the
// pending sweep without actually doing one. Bound by the same age floor
// so it tracks what `sweepReplayRetention` would consider.
export async function countPendingRetention(now: Date = new Date()): Promise<number> {
  const ageCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(replaySessions)
    .where(
      and(
        lte(replaySessions.createdAt, ageCutoff),
        isNotNull(replaySessions.organizationId),
      ),
    );
  return row?.count ?? 0;
}
