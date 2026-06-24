/**
 * Aggregations backing the Shadow Classification widget in /admin/ai.
 *
 * Fase 6 scope — three metrics only:
 *   1. Tier distribution   — count of shadow classifications per tier.
 *   2. Classifier accuracy — placeholder until a 50-sample human-labeling
 *                            backfill lands (Fase 6 acceptance criterion).
 *                            For now we approximate with outcome-based signal:
 *                            `accurate` = session with tier_used IN ('0','1','2','3')
 *                            AND status='completed' AND monitoring_status='passed'.
 *                            The real measurement is tier agreement with a human
 *                            reviewer; that pipeline ships with the widget
 *                            richer UI post-soak (14d) as the user requested.
 *   3. Pattern lookup hit rate — share of ai_usage_logs rows with
 *                                phase='pattern_lookup' whose match count > 0.
 *
 * All queries read the last 7 days; the widget is a point-in-time snapshot.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type TierDistribution = {
  tier: "0" | "1" | "2" | "3" | "legacy";
  count: number;
}[];

export type AccuracyStats = {
  labeledCount: number;
  accurateCount: number;
  accuracyPct: number; // 0..100
  /** True until the manual 50-sample backfill produces labels. Drives the
   *  "approximation" badge in the widget. */
  isApproximation: boolean;
};

export type LookupHitRate = {
  totalLookups: number;
  hits: number;              // lookups with at least one match at >= 0.88
  hitRatePct: number;        // 0..100
};

const SEVEN_DAYS = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

export async function getTierDistribution(): Promise<TierDistribution> {
  type Row = { tier_used: string | null; count: string | number };
  const res = await db.execute<Row>(sql`
    SELECT tier_used, COUNT(*)::int AS count
    FROM remediation_sessions
    WHERE created_at > ${SEVEN_DAYS()}
      AND tier_used IS NOT NULL
    GROUP BY tier_used
    ORDER BY tier_used ASC
  `);
  const rows = Array.isArray(res) ? res : ((res as { rows?: Row[] }).rows ?? []);
  const out: TierDistribution = [];
  for (const r of rows) {
    const tier = r.tier_used;
    if (tier === "0" || tier === "1" || tier === "2" || tier === "3" || tier === "legacy") {
      out.push({
        tier,
        count: typeof r.count === "number" ? r.count : parseInt(String(r.count), 10) || 0,
      });
    }
  }
  return out;
}

/**
 * When `tier_router_labels` (Fase 6.1) holds ≥ 50 rows, return real
 * agreement: the share of the latest label per session that matches the
 * classifier's `tier_used`. Below 50 rows we fall back to the original
 * outcome-based approximation (`status='completed' AND monitoring_status
 * IN ('passed', NULL)`) so the widget stays useful before the labeling
 * backfill clears the gate.
 */
export async function getClassifierAccuracy(): Promise<AccuracyStats> {
  type LabelRow = { total: string | number; agreed: string | number };
  const labelRes = await db.execute<LabelRow>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (l.session_id) l.session_id, l.human_tier
      FROM tier_router_labels l
      ORDER BY l.session_id, l.created_at DESC
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE r.tier_used = latest.human_tier)::int AS agreed
    FROM latest
    JOIN remediation_sessions r ON r.id = latest.session_id
    WHERE r.tier_used IS NOT NULL
  `);
  const labelRows = Array.isArray(labelRes) ? labelRes : ((labelRes as { rows?: LabelRow[] }).rows ?? []);
  const labelRow = labelRows[0];
  const labelTotal = typeof labelRow?.total === "number" ? labelRow.total : parseInt(String(labelRow?.total ?? 0), 10) || 0;
  const labelAgreed = typeof labelRow?.agreed === "number" ? labelRow.agreed : parseInt(String(labelRow?.agreed ?? 0), 10) || 0;

  if (labelTotal >= 50) {
    return {
      labeledCount: labelTotal,
      accurateCount: labelAgreed,
      accuracyPct: Math.round((labelAgreed / labelTotal) * 100),
      isApproximation: false,
    };
  }

  type Row = { labeled: string | number; accurate: string | number };
  const res = await db.execute<Row>(sql`
    SELECT
      COUNT(*) FILTER (WHERE tier_used IS NOT NULL)::int AS labeled,
      COUNT(*) FILTER (
        WHERE tier_used IS NOT NULL
          AND status = 'completed'
          AND (monitoring_status = 'passed' OR monitoring_status IS NULL)
      )::int AS accurate
    FROM remediation_sessions
    WHERE created_at > ${SEVEN_DAYS()}
  `);
  const rows = Array.isArray(res) ? res : ((res as { rows?: Row[] }).rows ?? []);
  const row = rows[0];
  const labeled = typeof row?.labeled === "number" ? row.labeled : parseInt(String(row?.labeled ?? 0), 10) || 0;
  const accurate = typeof row?.accurate === "number" ? row.accurate : parseInt(String(row?.accurate ?? 0), 10) || 0;
  return {
    labeledCount: labeled,
    accurateCount: accurate,
    accuracyPct: labeled === 0 ? 0 : Math.round((accurate / labeled) * 100),
    isApproximation: true,
  };
}

/**
 * Hit rate = share of pattern_lookup operations whose result carried at
 * least one match. The minScore (0.88) is enforced inside `lookupPattern`
 * before the row is logged, so any non-zero match count counts as a hit.
 *
 * Reads the JSON `response` column of ai_usage_logs where pattern-memory.ts
 * encodes { patternId, score, matchCount }.
 */
export async function getLookupHitRate(): Promise<LookupHitRate> {
  type Row = { total: string | number; hits: string | number };
  const res = await db.execute<Row>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE (response::jsonb ->> 'matchCount')::int > 0
      )::int AS hits
    FROM ai_usage_logs
    WHERE phase = 'pattern_lookup'
      AND created_at > ${SEVEN_DAYS()}
      AND response IS NOT NULL
  `);
  const rows = Array.isArray(res) ? res : ((res as { rows?: Row[] }).rows ?? []);
  const row = rows[0];
  const total = typeof row?.total === "number" ? row.total : parseInt(String(row?.total ?? 0), 10) || 0;
  const hits = typeof row?.hits === "number" ? row.hits : parseInt(String(row?.hits ?? 0), 10) || 0;
  return {
    totalLookups: total,
    hits,
    hitRatePct: total === 0 ? 0 : Math.round((hits / total) * 100),
  };
}
