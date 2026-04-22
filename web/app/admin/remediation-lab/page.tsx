export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Remediation Lab — InariWatch" };

// Admin gate matches /admin/ai/page.tsx — the ADMIN_EMAIL env var is the
// single source of truth for admin access across internal pages.
function requireAdmin(email: string | null | undefined): boolean {
  const adminEmail = process.env.ADMIN_EMAIL;
  return !!adminEmail && email === adminEmail;
}

const SEVEN_DAYS_AGO = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const ONE_DAY_AGO = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

// ── Types ──────────────────────────────────────────────────────────────────

interface WallTimeByTier {
  tier: string;
  sessionCount: number;
  p50Seconds: number;
  p95Seconds: number;
}

interface CostByPhase {
  phase: string;
  totalCostUsd: number;
  callCount: number;
  avgCostUsd: number;
}

interface ModelMixDay {
  day: string;
  model: string;
  callCount: number;
}

interface TrendPoint {
  day: string;
  p50Seconds: number;
  p95Seconds: number;
  sessionCount: number;
}

interface CacheHitByFeature {
  feature: string;
  callCount: number;
  cacheHits: number;
  hitRate: number;
}

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * p50/p95 wall time per `tier_used` over the last 7 days.
 *
 * Wall time = (updated_at - created_at) for sessions that reached a terminal
 * state. Sessions with `tier_used IS NULL` are bucketed as 'unclassified' so
 * pre-Fase-6 traffic shows up in the histogram without distorting per-tier
 * stats. Terminal statuses match the existing set in remediate.ts.
 */
async function getWallTimeByTier(): Promise<WallTimeByTier[]> {
  const rows = await db.execute(sql`
    SELECT
      COALESCE(tier_used, 'unclassified') AS tier,
      COUNT(*)::text AS session_count,
      percentile_cont(0.50) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))
      )::text AS p50,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))
      )::text AS p95
    FROM remediation_sessions
    WHERE created_at > ${SEVEN_DAYS_AGO()}
      AND status IN ('completed', 'failed', 'cancelled', 'merging')
    GROUP BY COALESCE(tier_used, 'unclassified')
    ORDER BY session_count DESC
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  return (list as Record<string, unknown>[]).map((r) => ({
    tier: String(r.tier ?? "unclassified"),
    sessionCount: parseInt(String(r.session_count ?? "0")),
    p50Seconds: parseFloat(String(r.p50 ?? "0")),
    p95Seconds: parseFloat(String(r.p95 ?? "0")),
  }));
}

/**
 * Cost attribution per phase over 7 days. NULL phases bucketed as
 * 'unattributed' until Fase 3 threads phase through the container agent.
 */
async function getCostByPhase(): Promise<CostByPhase[]> {
  const rows = await db.execute(sql`
    SELECT
      COALESCE(phase, 'unattributed') AS phase,
      SUM(cost_usd)::text AS total_cost,
      COUNT(*)::text AS call_count,
      AVG(cost_usd)::text AS avg_cost
    FROM ai_usage_logs
    WHERE created_at > ${SEVEN_DAYS_AGO()}
    GROUP BY COALESCE(phase, 'unattributed')
    ORDER BY SUM(cost_usd) DESC NULLS LAST
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  return (list as Record<string, unknown>[]).map((r) => ({
    phase: String(r.phase ?? "unattributed"),
    totalCostUsd: parseFloat(String(r.total_cost ?? "0")),
    callCount: parseInt(String(r.call_count ?? "0")),
    avgCostUsd: parseFloat(String(r.avg_cost ?? "0")),
  }));
}

/**
 * Daily model-mix over 7 days. Shows which models are handling traffic so
 * operators can spot routing regressions (e.g. Tier 2 suddenly runs on
 * standard-tier when it should be on mini).
 */
async function getModelMix(): Promise<ModelMixDay[]> {
  const rows = await db.execute(sql`
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      model,
      COUNT(*)::text AS call_count
    FROM ai_usage_logs
    WHERE created_at > ${SEVEN_DAYS_AGO()}
    GROUP BY date_trunc('day', created_at), model
    ORDER BY day DESC, call_count DESC
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  return (list as Record<string, unknown>[]).map((r) => ({
    day: String(r.day ?? ""),
    model: String(r.model ?? "unknown"),
    callCount: parseInt(String(r.call_count ?? "0")),
  }));
}

/**
 * Daily p50/p95 wall time trend across all terminal remediations in the
 * 7-day window. The widget charts deviations above baseline so the tier
 * router's impact (Fase 6) is visible as a step change.
 */
async function getWallTimeTrend(): Promise<TrendPoint[]> {
  const rows = await db.execute(sql`
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      percentile_cont(0.50) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))
      )::text AS p50,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))
      )::text AS p95,
      COUNT(*)::text AS session_count
    FROM remediation_sessions
    WHERE created_at > ${SEVEN_DAYS_AGO()}
      AND status IN ('completed', 'failed', 'cancelled', 'merging')
    GROUP BY date_trunc('day', created_at)
    ORDER BY day DESC
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  return (list as Record<string, unknown>[]).map((r) => ({
    day: String(r.day ?? ""),
    p50Seconds: parseFloat(String(r.p50 ?? "0")),
    p95Seconds: parseFloat(String(r.p95 ?? "0")),
    sessionCount: parseInt(String(r.session_count ?? "0")),
  }));
}

/**
 * Cache-hit rate per feature this week (acceptance criterion #2).
 *
 * Counts rows where `cached=true` over total per-feature rows in 7 days.
 * The `cached` column was added in migration 0056_ai_lens.sql so this
 * query works against all pre-Fase-1 traffic as well.
 */
async function getCacheHitByFeature(): Promise<CacheHitByFeature[]> {
  const rows = await db.execute(sql`
    SELECT
      feature,
      COUNT(*)::text AS call_count,
      COUNT(*) FILTER (WHERE cached = true)::text AS cache_hits
    FROM ai_usage_logs
    WHERE created_at > ${SEVEN_DAYS_AGO()}
    GROUP BY feature
    ORDER BY COUNT(*) DESC
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  return (list as Record<string, unknown>[]).map((r) => {
    const call = parseInt(String(r.call_count ?? "0"));
    const hits = parseInt(String(r.cache_hits ?? "0"));
    return {
      feature: String(r.feature ?? "unknown"),
      callCount: call,
      cacheHits: hits,
      hitRate: call > 0 ? (hits / call) * 100 : 0,
    };
  });
}

interface SandboxStats {
  totalInvocations: number;
  successRate: number;
  p95DurationMs: number;
  lastInvocation: string | null;
}

/**
 * Sandbox activity summary. Returns zeroes until Fase 5 wires the CodeAct
 * runner to write rows; present now so the widget renders a "0 invocations"
 * state correctly and so Fase 5 doesn't have to touch the UI.
 */
async function getSandboxStats(): Promise<SandboxStats> {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE success = true)::text AS successes,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95,
      MAX(created_at) AS last_at
    FROM sandbox_audit_log
    WHERE created_at > ${ONE_DAY_AGO()}
  `);
  const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows ?? rows;
  const r = (list as Record<string, unknown>[])[0] ?? {};
  const total = parseInt(String(r.total ?? "0"));
  const successes = parseInt(String(r.successes ?? "0"));
  return {
    totalInvocations: total,
    successRate: total > 0 ? (successes / total) * 100 : 0,
    p95DurationMs: parseFloat(String(r.p95 ?? "0")),
    lastInvocation: r.last_at ? new Date(String(r.last_at)).toISOString() : null,
  };
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function RemediationLabPage() {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string })?.email;
  if (!requireAdmin(email)) notFound();

  const [byTier, byPhase, modelMix, trend, cacheByFeature, sandboxStats] = await Promise.all([
    getWallTimeByTier(),
    getCostByPhase(),
    getModelMix(),
    getWallTimeTrend(),
    getCacheHitByFeature(),
    getSandboxStats(),
  ]);

  const totalSessions = byTier.reduce((s, t) => s + t.sessionCount, 0);
  const totalCost = byPhase.reduce((s, p) => s + p.totalCostUsd, 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-10">
          <p className="text-xs font-mono text-violet-400 uppercase tracking-widest mb-1">Admin · Fase 1</p>
          <h1 className="text-2xl font-bold">Remediation Lab</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Last 7 days · {totalSessions.toLocaleString()} terminal sessions · ${totalCost.toFixed(2)} AI spend
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            Fases 3/5/6 will populate phase, model_tier, and tier_used. Rows that predate them
            show as &quot;unattributed&quot; / &quot;unclassified&quot;.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Wall-time histogram by tier */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              Wall time by tier (7d)
            </h2>
            {byTier.length === 0 ? (
              <p className="text-sm text-zinc-500">No terminal remediations in the last 7 days.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Tier</th>
                    <th className="pb-2 text-right">Sessions</th>
                    <th className="pb-2 text-right">p50</th>
                    <th className="pb-2 text-right">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {byTier.map((t) => (
                    <tr key={t.tier} className="border-b border-zinc-900">
                      <td className="py-2 font-mono">{t.tier}</td>
                      <td className="py-2 text-right text-zinc-300">{t.sessionCount.toLocaleString()}</td>
                      <td className="py-2 text-right font-mono text-xs text-green-400">
                        {t.p50Seconds.toFixed(1)}s
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-amber-400">
                        {t.p95Seconds.toFixed(1)}s
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-zinc-500 mt-4">
              Acceptance question: &quot;What&apos;s the p50 wall time for Tier 2 remediations in the last 7 days?&quot;
              — read the Tier = &quot;2&quot; row&apos;s p50 column. Empty until Fase 6 writes tier_used.
            </p>
          </div>

          {/* Wall-time trend */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              p50 / p95 wall-time trend (7d)
            </h2>
            {trend.length === 0 ? (
              <p className="text-sm text-zinc-500">No data.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Day</th>
                    <th className="pb-2 text-right">Sessions</th>
                    <th className="pb-2 text-right">p50</th>
                    <th className="pb-2 text-right">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((t) => (
                    <tr key={t.day} className="border-b border-zinc-900">
                      <td className="py-2 font-mono text-xs">{t.day}</td>
                      <td className="py-2 text-right text-zinc-300">{t.sessionCount}</td>
                      <td className="py-2 text-right font-mono text-xs text-green-400">
                        {t.p50Seconds.toFixed(1)}s
                      </td>
                      <td className="py-2 text-right font-mono text-xs text-amber-400">
                        {t.p95Seconds.toFixed(1)}s
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Cost attribution by phase */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              Cost by phase (7d)
            </h2>
            {byPhase.length === 0 ? (
              <p className="text-sm text-zinc-500">No AI calls.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Phase</th>
                    <th className="pb-2 text-right">Total</th>
                    <th className="pb-2 text-right">Calls</th>
                    <th className="pb-2 text-right">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {byPhase.map((p) => (
                    <tr key={p.phase} className="border-b border-zinc-900">
                      <td className="py-2 font-mono">{p.phase}</td>
                      <td className="py-2 text-right text-zinc-300">${p.totalCostUsd.toFixed(4)}</td>
                      <td className="py-2 text-right text-zinc-400">{p.callCount.toLocaleString()}</td>
                      <td className="py-2 text-right font-mono text-xs text-zinc-500">
                        ${p.avgCostUsd.toFixed(6)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Cache-hit rate per feature (acceptance criterion #2) */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              Cache hit rate per feature (7d)
            </h2>
            {cacheByFeature.length === 0 ? (
              <p className="text-sm text-zinc-500">No AI calls.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Feature</th>
                    <th className="pb-2 text-right">Calls</th>
                    <th className="pb-2 text-right">Hits</th>
                    <th className="pb-2 text-right">Hit rate</th>
                  </tr>
                </thead>
                <tbody>
                  {cacheByFeature.map((f) => (
                    <tr key={f.feature} className="border-b border-zinc-900">
                      <td className="py-2 font-mono">{f.feature}</td>
                      <td className="py-2 text-right text-zinc-300">{f.callCount.toLocaleString()}</td>
                      <td className="py-2 text-right text-zinc-400">{f.cacheHits.toLocaleString()}</td>
                      <td className="py-2 text-right font-mono text-xs text-blue-400">
                        {f.hitRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-zinc-500 mt-4">
              Acceptance question: &quot;What is the cache hit rate on OpenAI calls for feature X this week?&quot;
              — read the feature&apos;s row.
            </p>
          </div>

          {/* Model mix */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              Model mix (7d, daily)
            </h2>
            {modelMix.length === 0 ? (
              <p className="text-sm text-zinc-500">No AI calls.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                    <th className="pb-2">Day</th>
                    <th className="pb-2">Model</th>
                    <th className="pb-2 text-right">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {modelMix.slice(0, 40).map((m) => (
                    <tr key={`${m.day}-${m.model}`} className="border-b border-zinc-900">
                      <td className="py-2 font-mono text-xs">{m.day}</td>
                      <td className="py-2 font-mono text-xs text-zinc-300">{m.model}</td>
                      <td className="py-2 text-right text-zinc-400">{m.callCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Sandbox stats — zero until Fase 5 */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 md:col-span-2">
            <h2 className="text-sm font-mono text-violet-400 uppercase tracking-wider mb-4">
              CodeAct sandbox (24h)
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-zinc-400">Invocations</p>
                <p className="text-2xl font-bold text-white">{sandboxStats.totalInvocations.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Success rate</p>
                <p className="text-2xl font-bold text-green-400">{sandboxStats.successRate.toFixed(1)}%</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">p95 duration</p>
                <p className="text-2xl font-bold text-amber-400">{sandboxStats.p95DurationMs.toFixed(0)}ms</p>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Last invocation</p>
                <p className="text-xs font-mono text-zinc-500 mt-2">
                  {sandboxStats.lastInvocation ? new Date(sandboxStats.lastInvocation).toLocaleString() : "none"}
                </p>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-4">
              Zeroes expected until Fase 5 ships the Deno+Pyodide runner (see ADR-001).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
