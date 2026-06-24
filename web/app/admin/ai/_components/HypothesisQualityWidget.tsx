/**
 * Fase 7 PR A — Hypothesis Quality widget
 *
 * Shadow-only observability for the hypothesis generator. Shows what
 * gpt-5-mini is producing in production so we can decide whether the
 * prompt is mature enough to invest in the coordinator (PR B).
 *
 * Metrics (last 24h):
 *   - sessions that ran hypothesis generation (distinct remediation_sessions
 *     with ai_usage_logs.phase='hypothesis')
 *   - avg hypothesis count / session (remediation_sessions.hypothesis_count)
 *   - p50 / p95 duration of the hypothesis call
 *   - total cost spent on hypothesis generation
 *
 * Server component — queries ai_usage_logs + remediation_sessions directly.
 */

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

interface HypothesisStats {
  sessions: number;
  calls: number;
  avgHypothesesPerSession: string;
  p50DurationMs: string;
  p95DurationMs: string;
  totalCostUsd: string;
}

async function fetchStats(): Promise<HypothesisStats> {
  const rows = await db.execute<{
    sessions: string;
    calls: string;
    avg_hyp: string | null;
    p50_ms: string | null;
    p95_ms: string | null;
    total_cost: string | null;
  }>(sql`
    WITH calls AS (
      SELECT
        remediation_session_id,
        duration_ms,
        cost_usd
      FROM ai_usage_logs
      WHERE phase = 'hypothesis'
        AND created_at > NOW() - INTERVAL '24 hours'
    ),
    counts AS (
      SELECT AVG(hypothesis_count)::text AS avg_hyp
      FROM remediation_sessions
      WHERE hypothesis_count IS NOT NULL
        AND created_at > NOW() - INTERVAL '24 hours'
    )
    SELECT
      COUNT(DISTINCT calls.remediation_session_id)::text AS sessions,
      COUNT(*)::text AS calls,
      (SELECT avg_hyp FROM counts) AS avg_hyp,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::text AS p50_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95_ms,
      COALESCE(SUM(cost_usd), 0)::text AS total_cost
    FROM calls
  `);

  const r = rows.rows[0] ?? {
    sessions: "0", calls: "0", avg_hyp: null,
    p50_ms: null, p95_ms: null, total_cost: "0",
  };

  return {
    sessions: parseInt(r.sessions ?? "0"),
    calls: parseInt(r.calls ?? "0"),
    avgHypothesesPerSession: r.avg_hyp != null ? parseFloat(r.avg_hyp).toFixed(2) : "—",
    p50DurationMs: r.p50_ms != null ? Math.round(parseFloat(r.p50_ms)).toString() : "—",
    p95DurationMs: r.p95_ms != null ? Math.round(parseFloat(r.p95_ms)).toString() : "—",
    totalCostUsd: parseFloat(r.total_cost ?? "0").toFixed(4),
  };
}

export default async function HypothesisQualityWidget() {
  const stats = await fetchStats();

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider">
          Hypothesis Quality (Fase 7 PR A)
        </h2>
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
          24h · shadow-only
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <div>
          <p className="text-xs text-zinc-400 mb-2">Sessions with hypotheses</p>
          <p className="text-3xl font-bold text-white">{stats.sessions}</p>
          <p className="text-xs text-zinc-500 mt-2">
            {stats.calls} call{stats.calls === 1 ? "" : "s"} total
          </p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">Avg hypotheses / session</p>
          <p className="text-3xl font-bold text-white">{stats.avgHypothesesPerSession}</p>
          <p className="text-xs text-zinc-500 mt-2">target: 3-5</p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">Latency</p>
          <p className="text-2xl font-bold text-white">
            {stats.p50DurationMs}
            <span className="text-sm text-zinc-500 ml-1">/ {stats.p95DurationMs}</span>
            <span className="text-xs text-zinc-500 ml-1">ms</span>
          </p>
          <p className="text-xs text-zinc-500 mt-2">p50 / p95</p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">Cost (24h)</p>
          <p className="text-3xl font-bold text-green-400">${stats.totalCostUsd}</p>
          <p className="text-xs text-zinc-500 mt-2">gpt-5-mini</p>
        </div>
      </div>

      <p className="text-xs text-zinc-600 mt-4">
        Shadow only — hypotheses are generated + logged but never dispatched. PR B (coordinator + sub-agents)
        reads these metrics to decide when the prompt is mature enough to invest in fan-out.
      </p>
    </div>
  );
}
