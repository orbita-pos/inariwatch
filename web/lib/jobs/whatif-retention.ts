/**
 * What-If replay cache retention.
 *
 * `whatif_replays.result` is a JSONB column that stores the full
 * substrate_replay payload including potentially-sensitive recorded
 * events (HTTP headers, DB query params — scrubbed by the worker but
 * not guaranteed to be secret-free in every possible recording shape).
 * The column has no built-in TTL so without a sweep it accumulates
 * forever.
 *
 * Policy: drop rows where `computed_at < NOW - 30d`. Users who
 * actively view a fix get fresh compute on demand if cache has
 * expired. Thirty days matches the retention window we communicate
 * in the privacy policy for replay data (/privacy).
 *
 * Batch cap: 1000 rows per run. A healthy install produces a few
 * What-If clicks per day; a 1000-row cap soaks up even large backlogs
 * in a single run while staying well within a cron request window.
 */

import { db } from "@/lib/db";
import { whatifReplays } from "@/lib/db/schema";
import { and, lt, sql } from "drizzle-orm";

const RETENTION_DAYS = 30;
const MAX_BATCH = 1000;

export interface WhatIfRetentionResult {
  deleted: number;
  cutoffIso: string;
  cappedAtBatch: boolean;
}

export async function sweepWhatIfRetention(): Promise<WhatIfRetentionResult> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // DELETE ... WHERE id IN (subquery LIMIT N) is the portable way to
  // cap a delete in Postgres. Drizzle doesn't wrap this directly so
  // we drop to a raw query here — single callsite, simple shape.
  const result = await db.execute(sql`
    DELETE FROM whatif_replays
    WHERE id IN (
      SELECT id FROM whatif_replays
      WHERE computed_at < ${cutoff.toISOString()}
      ORDER BY computed_at ASC
      LIMIT ${MAX_BATCH}
    )
  `);

  // neon-http returns rowCount; fall back to 0 if the driver shape
  // ever changes — the sweep is eventually-consistent either way.
  const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0;

  return {
    deleted,
    cutoffIso: cutoff.toISOString(),
    cappedAtBatch: deleted >= MAX_BATCH,
  };
}

/**
 * Count how many rows are eligible for deletion without actually
 * running the sweep. Surfaced in the cron response so ops can see
 * backlog depth and bump the batch cap or schedule if needed.
 */
export async function countPendingWhatIfRetention(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(whatifReplays)
    .where(and(lt(whatifReplays.computedAt, cutoff)));
  return row?.n ?? 0;
}
