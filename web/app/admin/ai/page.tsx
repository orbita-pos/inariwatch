export const dynamic = "force-dynamic";

import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ShadowClassificationWidget from "./_components/ShadowClassificationWidget";
import SLOStatusWidget from "./_components/SLOStatusWidget";

export const metadata: Metadata = { title: "AI Observability — InariWatch" };

function requireAdmin(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === adminEmail;
}

const SEVEN_DAYS_AGO = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const ONE_DAY_AGO = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

interface FeatureSpend {
  feature: string;
  totalCost: string;
  callCount: number;
  avgCost: string;
}

interface ModelSpend {
  model: string;
  provider: string;
  totalCost: string;
  callCount: number;
}

interface ClassifierStats {
  triageClass: string;
  count: number;
}

interface CostPercentiles {
  p50Cost: string;
  p95Cost: string;
}

async function getSpendByFeature(): Promise<FeatureSpend[]> {
  const rows = await db.execute<{
    feature: string;
    total_cost: string;
    call_count: string;
    avg_cost: string;
  }>(sql`
    SELECT
      feature,
      SUM(cost_usd)::text AS total_cost,
      COUNT(*)::text AS call_count,
      AVG(cost_usd)::text AS avg_cost
    FROM ai_usage_logs
    WHERE created_at > ${SEVEN_DAYS_AGO()}
    GROUP BY feature
    ORDER BY SUM(cost_usd) DESC
  `);
  const list = (rows as unknown as { rows: { feature: string; total_cost: string; call_count: string; avg_cost: string }[] }).rows ?? rows;
  return (list as { feature: string; total_cost: string; call_count: string; avg_cost: string }[]).map((r) => ({
    feature: r.feature,
    totalCost: parseFloat(r.total_cost ?? "0").toFixed(4),
    callCount: parseInt(r.call_count ?? "0"),
    avgCost: parseFloat(r.avg_cost ?? "0").toFixed(6),
  }));
}

async function getSpendByModel(): Promise<ModelSpend[]> {
  const rows = await db.execute(sql`
    SELECT
      model,
      provider,
      SUM(cost_usd)::text AS total_cost,
      COUNT(*)::text AS call_count
    FROM ai_usage_logs
    WHERE created_at > ${SEVEN_DAYS_AGO()}
    GROUP BY model, provider
    ORDER BY SUM(cost_usd) DESC
  `);
  const list = (rows as unknown as { rows: { model: string; provider: string; total_cost: string; call_count: string }[] }).rows ?? rows;
  return (list as { model: string; provider: string; total_cost: string; call_count: string }[]).map((r) => ({
    model: r.model,
    provider: r.provider,
    totalCost: parseFloat(r.total_cost ?? "0").toFixed(4),
    callCount: parseInt(r.call_count ?? "0"),
  }));
}

async function getClassifierDistribution(): Promise<ClassifierStats[]> {
  const rows = await db.execute(sql`
    SELECT
      COALESCE(correlation_data->>'triageClass', 'unclassified') AS triage_class,
      COUNT(*)::text AS count
    FROM alerts
    WHERE created_at > ${SEVEN_DAYS_AGO()}
    GROUP BY triage_class
    ORDER BY COUNT(*) DESC
  `);
  const list = (rows as unknown as { rows: { triage_class: string; count: string }[] }).rows ?? rows;
  return (list as { triage_class: string; count: string }[]).map((r) => ({
    triageClass: r.triage_class,
    count: parseInt(r.count ?? "0"),
  }));
}

async function getCacheHitRate(): Promise<{ hitRate: number; cacheHits: number; total: number }> {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE correlation_data->>'analyzeModel' = 'redis-cache')::text AS cache_hits,
      COUNT(*)::text AS total
    FROM alerts
    WHERE created_at > ${ONE_DAY_AGO()}
      AND correlation_data IS NOT NULL
  `);
  const list = (rows as unknown as { rows: { cache_hits: string; total: string }[] }).rows ?? rows;
  const r = (list as { cache_hits: string; total: string }[])[0] ?? { cache_hits: "0", total: "0" };
  const cacheHits = parseInt(r.cache_hits ?? "0");
  const total = parseInt(r.total ?? "0");
  return {
    hitRate: total > 0 ? (cacheHits / total) * 100 : 0,
    cacheHits,
    total,
  };
}

async function getCostPercentiles(): Promise<CostPercentiles> {
  const rows = await db.execute(sql`
    SELECT
      percentile_cont(0.50) WITHIN GROUP (ORDER BY cost_usd)::text AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY cost_usd)::text AS p95
    FROM ai_usage_logs
    WHERE created_at > ${SEVEN_DAYS_AGO()}
      AND feature IN ('auto-analyze', 'remediation', 'correlate')
  `);
  const list = (rows as unknown as { rows: { p50: string; p95: string }[] }).rows ?? rows;
  const r = (list as { p50: string; p95: string }[])[0] ?? { p50: "0", p95: "0" };
  return {
    p50Cost: parseFloat(r.p50 ?? "0").toFixed(6),
    p95Cost: parseFloat(r.p95 ?? "0").toFixed(6),
  };
}

async function getTotalSpend(): Promise<{ total: string; calls: number }> {
  const rows = await db.execute(sql`
    SELECT
      SUM(cost_usd)::text AS total,
      COUNT(*)::text AS calls
    FROM ai_usage_logs
    WHERE created_at > ${SEVEN_DAYS_AGO()}
  `);
  const list = (rows as unknown as { rows: { total: string; calls: string }[] }).rows ?? rows;
  const r = (list as { total: string; calls: string }[])[0] ?? { total: "0", calls: "0" };
  return {
    total: parseFloat(r.total ?? "0").toFixed(2),
    calls: parseInt(r.calls ?? "0"),
  };
}

interface SessionSummary {
  sessionId: string;
  alertTitle: string | null;
  status: string;
  turns: number;
  totalCost: string;
  startedAt: string;
}

interface SessionStats {
  avgTurns: string;
  p95Turns: string;
  avgCost: string;
  sessionCount: number;
}

async function getRecentSessions(): Promise<SessionSummary[]> {
  const rows = await db.execute(sql`
    SELECT
      rs.id AS session_id,
      rs.status,
      rs.created_at,
      a.title AS alert_title,
      COUNT(aul.id)::text AS turns,
      COALESCE(SUM(aul.cost_usd), 0)::text AS total_cost
    FROM remediation_sessions rs
    LEFT JOIN alerts a ON a.id = rs.alert_id
    LEFT JOIN ai_usage_logs aul ON aul.remediation_session_id = rs.id
    WHERE rs.created_at > ${SEVEN_DAYS_AGO()}
    GROUP BY rs.id, rs.status, rs.created_at, a.title
    ORDER BY rs.created_at DESC
    LIMIT 20
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  return (list as Record<string, unknown>[]).map((r) => ({
    sessionId: String(r.session_id ?? ""),
    alertTitle: r.alert_title ? String(r.alert_title) : null,
    status: String(r.status ?? "unknown"),
    turns: parseInt(String(r.turns ?? "0")),
    totalCost: parseFloat(String(r.total_cost ?? "0")).toFixed(4),
    startedAt: r.created_at ? new Date(String(r.created_at)).toISOString() : "",
  }));
}

async function getSessionStats(): Promise<SessionStats> {
  const rows = await db.execute(sql`
    WITH session_agg AS (
      SELECT
        remediation_session_id,
        COUNT(*) AS turns,
        SUM(cost_usd) AS cost
      FROM ai_usage_logs
      WHERE remediation_session_id IS NOT NULL
        AND created_at > ${SEVEN_DAYS_AGO()}
      GROUP BY remediation_session_id
    )
    SELECT
      AVG(turns)::text AS avg_turns,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY turns)::text AS p95_turns,
      AVG(cost)::text AS avg_cost,
      COUNT(*)::text AS session_count
    FROM session_agg
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  const r = (list as Record<string, unknown>[])[0] ?? {};
  return {
    avgTurns: parseFloat(String(r.avg_turns ?? "0")).toFixed(1),
    p95Turns: parseFloat(String(r.p95_turns ?? "0")).toFixed(0),
    avgCost: parseFloat(String(r.avg_cost ?? "0")).toFixed(4),
    sessionCount: parseInt(String(r.session_count ?? "0")),
  };
}

export default async function AdminAIPage() {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!requireAdmin(email)) notFound();

  const [byFeature, byModel, classifierDist, cacheHits, percentiles, total, sessions, sessionStats] = await Promise.all([
    getSpendByFeature(),
    getSpendByModel(),
    getClassifierDistribution(),
    getCacheHitRate(),
    getCostPercentiles(),
    getTotalSpend(),
    getRecentSessions(),
    getSessionStats(),
  ]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-10">
          <p className="text-xs font-mono text-violet-400 uppercase tracking-widest mb-1">Admin</p>
          <h1 className="text-2xl font-bold">AI Observability</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Last 7 days · ${total.total} across {total.calls.toLocaleString()} calls ·
            <span className="text-green-400">InariLens</span> capturing all AI telemetry in our own infrastructure
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Cost-per-call North Star */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">Cost per call (auto-analyze + remediation + correlate)</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-zinc-400">p50</p>
                <p className="text-3xl font-bold text-green-400">${percentiles.p50Cost}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">p95</p>
                <p className="text-3xl font-bold text-amber-400">${percentiles.p95Cost}</p>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-4">Watch p95 — if it spikes, a regression slipped in.</p>
          </div>

          {/* Session-level metrics — baseline for "mejor del mundo" plan */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              Remediation session baseline (7d) · {sessionStats.sessionCount} sessions
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-zinc-400">Avg turns / session</p>
                <p className="text-2xl font-bold text-white">{sessionStats.avgTurns}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">p95 turns</p>
                <p className="text-2xl font-bold text-amber-400">{sessionStats.p95Turns}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Avg cost / session</p>
                <p className="text-2xl font-bold text-green-400">${sessionStats.avgCost}</p>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-4">
              Baseline for the GPT-5.4 migration. Target post-PRs: avg turns -30%, avg cost $0.25→$0.08.
            </p>
          </div>

          {/* Fase 12 Part A — SLO status */}
          <SLOStatusWidget />

          {/* Fase 6 — Shadow classification metrics */}
          <ShadowClassificationWidget />

          {/* Recent sessions — drill-down list */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">Recent remediation sessions</h2>
            {sessions.length === 0 ? (
              <p className="text-sm text-zinc-500">No sessions yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">ID</th>
                    <th className="pb-2">Alert</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2 text-right">Turns</th>
                    <th className="pb-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.sessionId} className="border-b border-zinc-900 hover:bg-zinc-900/30">
                      <td className="py-2 font-mono text-xs">
                        <Link
                          href={`/admin/ai/session/${s.sessionId}`}
                          className="text-violet-400 hover:underline"
                        >
                          {s.sessionId.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className="py-2 text-zinc-300 max-w-xs truncate">
                        {s.alertTitle ?? <span className="text-zinc-500 italic">—</span>}
                      </td>
                      <td className="py-2">
                        <span
                          className={
                            s.status === "completed" || s.status === "merging"
                              ? "text-green-400 text-xs font-mono"
                              : s.status === "failed" || s.status === "cancelled"
                                ? "text-red-400 text-xs font-mono"
                                : "text-amber-400 text-xs font-mono"
                          }
                        >
                          {s.status}
                        </span>
                      </td>
                      <td className="py-2 text-right text-zinc-400">{s.turns}</td>
                      <td className="py-2 text-right font-mono text-xs text-green-400">${s.totalCost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Spend by Feature */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">Spend by feature (7d)</h2>
            {byFeature.length === 0 ? (
              <p className="text-sm text-zinc-500">No data yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Feature</th>
                    <th className="pb-2 text-right">Total</th>
                    <th className="pb-2 text-right">Calls</th>
                    <th className="pb-2 text-right">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {byFeature.map((f) => (
                    <tr key={f.feature} className="border-b border-zinc-900">
                      <td className="py-2 font-mono">{f.feature}</td>
                      <td className="py-2 text-right">${f.totalCost}</td>
                      <td className="py-2 text-right text-zinc-400">{f.callCount.toLocaleString()}</td>
                      <td className="py-2 text-right text-zinc-500 font-mono text-xs">${f.avgCost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Spend by Model/Tier */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">Spend by model (7d)</h2>
            {byModel.length === 0 ? (
              <p className="text-sm text-zinc-500">No data yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Model</th>
                    <th className="pb-2">Provider</th>
                    <th className="pb-2 text-right">Total</th>
                    <th className="pb-2 text-right">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map((m) => (
                    <tr key={`${m.provider}-${m.model}`} className="border-b border-zinc-900">
                      <td className="py-2 font-mono text-xs">{m.model}</td>
                      <td className="py-2 text-zinc-400">{m.provider}</td>
                      <td className="py-2 text-right">${m.totalCost}</td>
                      <td className="py-2 text-right text-zinc-400">{m.callCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Classifier Distribution */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">Classifier distribution (7d)</h2>
            {classifierDist.length === 0 ? (
              <p className="text-sm text-zinc-500">No data yet.</p>
            ) : (
              <ClassifierBars dist={classifierDist} />
            )}
          </div>

          {/* Cache Hit Rate */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">Cache hit rate (24h)</h2>
            <div>
              <p className="text-3xl font-bold text-blue-400">{cacheHits.hitRate.toFixed(1)}%</p>
              <p className="text-xs text-zinc-400 mt-2">
                {cacheHits.cacheHits.toLocaleString()} / {cacheHits.total.toLocaleString()} alerts served from Redis cache
              </p>
              <p className="text-xs text-zinc-500 mt-4">
                If &lt; 20% after 1 week of traffic → consider semantic cache (item 1.6/1.7).
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClassifierBars({ dist }: { dist: ClassifierStats[] }) {
  const total = dist.reduce((s, d) => s + d.count, 0);
  const colors: Record<string, string> = {
    auto_fix: "bg-green-500",
    triage_only: "bg-blue-500",
    full_remediation: "bg-amber-500",
    none: "bg-zinc-600",
    unclassified: "bg-zinc-700",
  };
  return (
    <div className="space-y-3">
      {dist.map((d) => {
        const pct = total > 0 ? (d.count / total) * 100 : 0;
        return (
          <div key={d.triageClass}>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-mono text-zinc-300">{d.triageClass}</span>
              <span className="text-zinc-400">{d.count.toLocaleString()} ({pct.toFixed(1)}%)</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded overflow-hidden">
              <div className={`h-full ${colors[d.triageClass] ?? "bg-zinc-600"}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
