/**
 * Fase 12 Part A — SLO monitor
 *
 * Measures per-tier success rate and p95 latency on a rolling 15-minute
 * window over `remediation_sessions`. Writes breaches to `slo_events`.
 *
 * Reads: `remediation_sessions` (tier_used, status, created_at, updated_at).
 * Writes: `slo_events` (one open row per (tier, metric)).
 *
 * Thresholds per tier come from `SLO_DEFINITIONS` below, which mirror the
 * arch spec (REMEDIATION_SYSTEM_ARCHITECTURE.md §Fase 12). A breach is
 * recorded when:
 *
 *   - success_rate   < threshold, OR
 *   - p95_latency_ms > threshold
 *
 * Short windows with a small sample count are skipped — we do not fire
 * on noise. Minimum sample threshold is per-tier (rare tiers have looser
 * minimums so we still get signal).
 */

import { db, sloEvents, remediationSessions } from "@/lib/db";
import { sql, eq, and, isNull, inArray } from "drizzle-orm";
import type { SLOEvent } from "@/lib/db";

// ── SLO definitions ────────────────────────────────────────────────────────
//
// Thresholds per arch spec §Fase 12. Keep success_rate as a fraction [0,1]
// internally; UI layer converts to percent.

export type Tier = "0" | "1" | "2" | "3";
export type Metric = "p95_latency_ms" | "success_rate";

export interface TierSLO {
  p95LatencyMs: number;
  successRate: number;
  /** Minimum sessions in the window to evaluate SLOs. Rare tiers have */
  /** lower minimums so a single outlier doesn't dominate. */
  minSamples: number;
}

export const SLO_DEFINITIONS: Record<Tier, TierSLO> = {
  "0": { p95LatencyMs: 1_000,   successRate: 0.95, minSamples: 5 },
  "1": { p95LatencyMs: 20_000,  successRate: 0.85, minSamples: 3 },
  "2": { p95LatencyMs: 90_000,  successRate: 0.88, minSamples: 3 },
  "3": { p95LatencyMs: 180_000, successRate: 0.85, minSamples: 1 },
};

export const ALL_TIERS: Tier[] = ["0", "1", "2", "3"];
export const ALL_METRICS: Metric[] = ["p95_latency_ms", "success_rate"];

/** Rolling window the cron measures over. Kept here so the widget and */
/** cron agree on the number shown to the operator. */
export const WINDOW_MINUTES = 15;

/** `consecutive_breach_count >= this` is the paging threshold. Matches */
/** the arch spec ("Tier 1 p95 > 30s for 3 consecutive 5-min windows"). */
export const PAGING_THRESHOLD = 3;

// ── Measurement ────────────────────────────────────────────────────────────

export interface TierMeasurement {
  tier: Tier;
  sampleCount: number;
  successCount: number;
  /** Null when sampleCount < minSamples — too few rows to compute. */
  successRate: number | null;
  /** Null when sampleCount < minSamples. Milliseconds. */
  p95LatencyMs: number | null;
}

/**
 * Query `remediation_sessions` for the last `windowMinutes` minutes and
 * aggregate by `tier_used`. Only rows with a terminal status contribute
 * to the measurement — `completed` is success, `failed` / `cancelled`
 * are failures. Sessions still in flight are skipped.
 */
export async function measureTiers(windowMinutes = WINDOW_MINUTES): Promise<TierMeasurement[]> {
  // Using raw SQL for percentile_cont — drizzle's aggregation helpers do
  // not cover percentile functions without a raw escape anyway.
  const rows = await db.execute<{
    tier: string;
    sample_count: string;
    success_count: string;
    p95_ms: string | null;
  }>(sql`
    SELECT
      tier_used AS tier,
      COUNT(*)::text AS sample_count,
      COUNT(*) FILTER (WHERE status = 'completed')::text AS success_count,
      PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000
      )::text AS p95_ms
    FROM remediation_sessions
    WHERE tier_used IS NOT NULL
      AND tier_used IN ('0', '1', '2', '3')
      AND status IN ('completed', 'failed', 'cancelled')
      AND created_at > NOW() - (${windowMinutes}::text || ' minutes')::interval
    GROUP BY tier_used
  `);

  const byTier = new Map<Tier, TierMeasurement>();
  for (const t of ALL_TIERS) {
    byTier.set(t, {
      tier: t,
      sampleCount: 0,
      successCount: 0,
      successRate: null,
      p95LatencyMs: null,
    });
  }

  for (const row of rows.rows) {
    const tier = row.tier as Tier;
    if (!ALL_TIERS.includes(tier)) continue;
    const slo = SLO_DEFINITIONS[tier];
    const sampleCount = Number(row.sample_count);
    const successCount = Number(row.success_count);
    const p95Raw = row.p95_ms == null ? null : Number(row.p95_ms);

    const hasEnough = sampleCount >= slo.minSamples;
    byTier.set(tier, {
      tier,
      sampleCount,
      successCount,
      successRate: hasEnough && sampleCount > 0 ? successCount / sampleCount : null,
      p95LatencyMs: hasEnough && p95Raw != null ? p95Raw : null,
    });
  }

  return Array.from(byTier.values());
}

// ── Breach detection ───────────────────────────────────────────────────────

export interface BreachCheck {
  tier: Tier;
  metric: Metric;
  threshold: number;
  observed: number;
  sampleCount: number;
}

/**
 * Split a list of measurements into breach/ok pairs. A breach is
 * recorded only when the measurement has enough samples AND the observed
 * value crosses the threshold. Measurements with `null` values (too few
 * samples) are treated as non-breaches — we neither open nor close
 * events, which avoids flipping state on sparse tiers.
 */
export function detectBreaches(measurements: TierMeasurement[]): {
  breaches: BreachCheck[];
  okPairs: { tier: Tier; metric: Metric }[];
} {
  const breaches: BreachCheck[] = [];
  const okPairs: { tier: Tier; metric: Metric }[] = [];

  for (const m of measurements) {
    const slo = SLO_DEFINITIONS[m.tier];

    if (m.successRate != null) {
      if (m.successRate < slo.successRate) {
        breaches.push({
          tier: m.tier,
          metric: "success_rate",
          threshold: slo.successRate,
          observed: m.successRate,
          sampleCount: m.sampleCount,
        });
      } else {
        okPairs.push({ tier: m.tier, metric: "success_rate" });
      }
    }

    if (m.p95LatencyMs != null) {
      if (m.p95LatencyMs > slo.p95LatencyMs) {
        breaches.push({
          tier: m.tier,
          metric: "p95_latency_ms",
          threshold: slo.p95LatencyMs,
          observed: m.p95LatencyMs,
          sampleCount: m.sampleCount,
        });
      } else {
        okPairs.push({ tier: m.tier, metric: "p95_latency_ms" });
      }
    }
  }

  return { breaches, okPairs };
}

// ── Persistence ────────────────────────────────────────────────────────────

export interface RecordResult {
  /** Open event IDs touched (either created or updated). */
  openedOrUpdated: string[];
  /** Event IDs closed in this run (recovered below threshold). */
  resolved: string[];
}

/**
 * Upsert breaches as open `slo_events` rows and stamp recovery on any
 * open rows whose metric is now healthy.
 *
 * One DB hit per breach (ON CONFLICT upsert) + one bulk UPDATE for the
 * recovered set. No transaction — the operations are idempotent and do
 * not cross-depend; a partial failure on one metric doesn't corrupt
 * the others.
 */
export async function recordBreaches(
  breaches: BreachCheck[],
  okPairs: { tier: Tier; metric: Metric }[]
): Promise<RecordResult> {
  const openedOrUpdated: string[] = [];
  const resolved: string[] = [];

  for (const b of breaches) {
    // Atomic upsert against the partial unique index on (tier, metric)
    // WHERE resolved_at IS NULL. On conflict we bump the counter and
    // refresh last_breach_at + observed_value; first_breach_at and
    // threshold_value are preserved from the first row so the audit
    // trail reflects the threshold-at-time-of-breach.
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO slo_events
        (tier, metric, threshold_value, observed_value, sample_count,
         consecutive_breach_count, first_breach_at, last_breach_at)
      VALUES
        (${b.tier}, ${b.metric}, ${b.threshold}, ${b.observed},
         ${b.sampleCount}, 1, NOW(), NOW())
      ON CONFLICT (tier, metric) WHERE resolved_at IS NULL
      DO UPDATE SET
        observed_value = EXCLUDED.observed_value,
        sample_count = EXCLUDED.sample_count,
        consecutive_breach_count = slo_events.consecutive_breach_count + 1,
        last_breach_at = NOW()
      RETURNING id
    `);
    if (rows.rows[0]?.id) openedOrUpdated.push(rows.rows[0].id);
  }

  if (okPairs.length > 0) {
    // Close any open events whose (tier, metric) is now below threshold.
    const tierList = Array.from(new Set(okPairs.map((p) => p.tier)));
    const metricList = Array.from(new Set(okPairs.map((p) => p.metric)));
    const rows = await db.execute<{ id: string; tier: string; metric: string }>(sql`
      UPDATE slo_events
      SET resolved_at = NOW()
      WHERE resolved_at IS NULL
        AND tier = ANY(${tierList})
        AND metric = ANY(${metricList})
        AND (tier, metric) IN (${sql.join(
          okPairs.map((p) => sql`(${p.tier}, ${p.metric})`),
          sql`, `
        )})
      RETURNING id, tier, metric
    `);
    for (const r of rows.rows) resolved.push(r.id);
  }

  return { openedOrUpdated, resolved };
}

// ── Orchestrator (called by the cron route) ────────────────────────────────

export interface SLOCheckReport {
  windowMinutes: number;
  measurements: TierMeasurement[];
  breaches: BreachCheck[];
  okPairs: { tier: Tier; metric: Metric }[];
  openedOrUpdated: string[];
  resolved: string[];
}

export async function runSLOCheck(windowMinutes = WINDOW_MINUTES): Promise<SLOCheckReport> {
  const measurements = await measureTiers(windowMinutes);
  const { breaches, okPairs } = detectBreaches(measurements);
  const { openedOrUpdated, resolved } = await recordBreaches(breaches, okPairs);
  return {
    windowMinutes,
    measurements,
    breaches,
    okPairs,
    openedOrUpdated,
    resolved,
  };
}

// ── Read helpers for the /admin/ai widget ──────────────────────────────────

export async function getActiveBreaches(): Promise<SLOEvent[]> {
  return db
    .select()
    .from(sloEvents)
    .where(isNull(sloEvents.resolvedAt))
    .orderBy(sql`${sloEvents.lastBreachAt} DESC`);
}

export async function getRecentHistory(hoursBack = 24): Promise<SLOEvent[]> {
  return db
    .select()
    .from(sloEvents)
    .where(sql`${sloEvents.createdAt} > NOW() - ${`${hoursBack} hours`}::interval`)
    .orderBy(sql`${sloEvents.createdAt} DESC`);
}

// Exposed for tests only — do not call from production code paths.
export const _internals = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _db: { db, sloEvents, remediationSessions, sql, eq, and, inArray },
};
