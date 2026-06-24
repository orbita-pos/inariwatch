/**
 * Fase 7 PR B — Multi-agent fan-out observability widget.
 *
 * Sessions with multiple sub-agents racing are identified via
 * `remediation_sessions.hypothesis_count >= 2` AND ai_usage_logs
 * entries whose `correlation_data` or tool traces imply a sub-agent
 * run. In PR B v1 we use the simplest signal available: remediation
 * sessions with `hypothesis_count >= 2` + completed-in-the-window +
 * total turn count > single-agent baseline.
 *
 * Shown metrics (24h rolling):
 *   - Sessions that fanned out (hypothesis_count >= 2 + completed
 *     after the fan-out flag was enabled).
 *   - Success rate of fan-out sessions vs. single-agent baseline.
 *   - Average turns of the winner vs. single-agent baseline.
 *   - Total cost.
 *
 * When MULTI_AGENT_FANOUT is off, this widget shows "not enabled".
 */

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

interface FanoutStats {
  enabled: boolean;
  sessions: number;
  successRate: string;
  avgTurnsWinner: string;
  totalCostUsd: string;
}

async function fetchStats(): Promise<FanoutStats> {
  const enabled = process.env.MULTI_AGENT_FANOUT === "true" || process.env.MULTI_AGENT_FANOUT === "1";

  const rows = await db.execute<{
    sessions: string;
    successes: string;
    avg_turns: string | null;
    total_cost: string | null;
  }>(sql`
    WITH fanout_sessions AS (
      SELECT id, status, hypothesis_count
      FROM remediation_sessions
      WHERE hypothesis_count IS NOT NULL
        AND hypothesis_count >= 2
        AND created_at > NOW() - INTERVAL '24 hours'
    ),
    winner_turns AS (
      SELECT
        aul.remediation_session_id,
        COUNT(*) AS turns,
        SUM(aul.cost_usd) AS cost
      FROM ai_usage_logs aul
      JOIN fanout_sessions fs ON fs.id = aul.remediation_session_id
      WHERE aul.phase IN ('fix', 'explore')
      GROUP BY aul.remediation_session_id
    )
    SELECT
      (SELECT COUNT(*)::text FROM fanout_sessions) AS sessions,
      (SELECT COUNT(*)::text FROM fanout_sessions WHERE status = 'completed') AS successes,
      AVG(turns)::text AS avg_turns,
      COALESCE(SUM(cost), 0)::text AS total_cost
    FROM winner_turns
  `);

  const r = rows.rows[0] ?? { sessions: "0", successes: "0", avg_turns: null, total_cost: "0" };
  const sessions = parseInt(r.sessions ?? "0");
  const successes = parseInt(r.successes ?? "0");
  const successRatePct = sessions > 0 ? ((successes / sessions) * 100).toFixed(1) : "—";

  return {
    enabled,
    sessions,
    successRate: successRatePct === "—" ? "—" : `${successRatePct}%`,
    avgTurnsWinner: r.avg_turns != null ? parseFloat(r.avg_turns).toFixed(1) : "—",
    totalCostUsd: parseFloat(r.total_cost ?? "0").toFixed(4),
  };
}

export default async function FanoutWidget() {
  const stats = await fetchStats();

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider">
          Multi-Agent Fan-out (Fase 7 PR B)
        </h2>
        <span
          className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${
            stats.enabled
              ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5"
              : "text-zinc-500 border-zinc-700 bg-zinc-800/40"
          }`}
        >
          {stats.enabled ? "FLAG ON" : "FLAG OFF"}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <div>
          <p className="text-xs text-zinc-400 mb-2">Fan-out sessions (24h)</p>
          <p className="text-3xl font-bold text-white">{stats.sessions}</p>
          <p className="text-xs text-zinc-500 mt-2">hypothesis_count ≥ 2</p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">Success rate</p>
          <p className="text-3xl font-bold text-white">{stats.successRate}</p>
          <p className="text-xs text-zinc-500 mt-2">
            target (vs single-agent): +3%
          </p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">Avg turns of winner</p>
          <p className="text-3xl font-bold text-white">{stats.avgTurnsWinner}</p>
          <p className="text-xs text-zinc-500 mt-2">baseline Tier 2: ~15</p>
        </div>

        <div>
          <p className="text-xs text-zinc-400 mb-2">Cost (24h)</p>
          <p className="text-3xl font-bold text-green-400">${stats.totalCostUsd}</p>
          <p className="text-xs text-zinc-500 mt-2">N sub-agents → expect N× cost</p>
        </div>
      </div>

      <p className="text-xs text-zinc-600 mt-4">
        {stats.enabled
          ? "Flag on. When Tier 2/3 sessions have ≥ 2 hypotheses + a staging server, remediate dispatches to the coordinator."
          : "Flag off. Set MULTI_AGENT_FANOUT=true in deploy.yml + kamal env push to activate. Watch the PR A HypothesisQualityWidget first — flip only after avg count settles to 3-5."}
      </p>
    </div>
  );
}
