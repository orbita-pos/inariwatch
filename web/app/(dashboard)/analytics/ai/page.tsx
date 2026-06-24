import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, remediationSessions, alerts, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { inArray, and, gte, sql } from "drizzle-orm";
import { Brain, Target, Shield, GitMerge, Activity, Clock, ChevronRight, TrendingUp, Zap } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "AI Metrics — Analytics" };

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((n / total) * 100)}%`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function getAIMetrics(projectIds: string[]) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const baseWhere = and(
    inArray(remediationSessions.projectId, projectIds),
    gte(remediationSessions.createdAt, thirtyDaysAgo)
  );

  const [
    overallRaw,
    perDayRaw,
    byStatusRaw,
    gateStatsRaw,
    mttrRaw,
    weeklyTrendRaw,
  ] = await Promise.all([
    // 1. Overall metrics (30 days)
    db.execute<{
      total: number;
      completed: number;
      failed: number;
      cancelled: number;
      auto_merged: number;
      draft_pr: number;
      avg_confidence: number;
      avg_decide_sec: number;
      monitoring_passed: number;
      monitoring_reverted: number;
      with_tests: number;
    }>(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE merge_strategy = 'auto_merged' AND status = 'completed')::int AS auto_merged,
        count(*) FILTER (WHERE merge_strategy = 'draft_pr')::int AS draft_pr,
        COALESCE(round(avg(confidence_score)), 0)::int AS avg_confidence,
        COALESCE(round(avg(EXTRACT(EPOCH FROM (updated_at - proposed_at)))), 0)::int AS avg_decide_sec,
        count(*) FILTER (WHERE monitoring_status = 'passed')::int AS monitoring_passed,
        count(*) FILTER (WHERE monitoring_status = 'reverted')::int AS monitoring_reverted,
        count(*) FILTER (WHERE file_changes::text LIKE '%test%' OR file_changes::text LIKE '%spec%')::int AS with_tests
      FROM remediation_sessions
      WHERE project_id = ANY(${projectIds})
        AND created_at >= ${thirtyDaysAgo}
    `),

    // 2. Per-day breakdown (30 days)
    db.execute<{ day: string; total: number; completed: number; failed: number }>(sql`
      SELECT
        to_char(created_at, 'YYYY-MM-DD') AS day,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM remediation_sessions
      WHERE project_id = ANY(${projectIds})
        AND created_at >= ${thirtyDaysAgo}
      GROUP BY day ORDER BY day
    `),

    // 3. Status distribution
    db.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int
      FROM remediation_sessions
      WHERE project_id = ANY(${projectIds})
        AND created_at >= ${thirtyDaysAgo}
      GROUP BY status ORDER BY count DESC
    `),

    // 4. Gate pass rates (from context JSON)
    db.execute<{
      total_with_gates: number;
      ci_passed: number;
      self_review_passed: number;
      security_passed: number;
      substrate_passed: number;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE status IN ('completed', 'proposing', 'merging'))::int AS total_with_gates,
        count(*) FILTER (WHERE status IN ('completed', 'proposing', 'merging'))::int AS ci_passed,
        count(*) FILTER (WHERE (self_review_result->>'score')::int >= 70)::int AS self_review_passed,
        count(*) FILTER (WHERE simulate_risk_score IS NOT NULL AND simulate_risk_score <= 40)::int AS substrate_passed,
        count(*) FILTER (WHERE confidence_score >= 60)::int AS security_passed
      FROM remediation_sessions
      WHERE project_id = ANY(${projectIds})
        AND created_at >= ${thirtyDaysAgo}
        AND status NOT IN ('analyzing', 'reading_code', 'cancelled')
    `),

    // 5. MTTR comparison (AI vs no-AI)
    db.execute<{ ai_mttr_sec: number; human_mttr_sec: number; ai_count: number; human_count: number }>(sql`
      SELECT
        COALESCE(round(avg(EXTRACT(EPOCH FROM (a.resolved_at - a.created_at)))
          FILTER (WHERE r.id IS NOT NULL AND r.status = 'completed')), 0)::int AS ai_mttr_sec,
        COALESCE(round(avg(EXTRACT(EPOCH FROM (a.resolved_at - a.created_at)))
          FILTER (WHERE r.id IS NULL)), 0)::int AS human_mttr_sec,
        count(*) FILTER (WHERE r.id IS NOT NULL AND r.status = 'completed')::int AS ai_count,
        count(*) FILTER (WHERE r.id IS NULL)::int AS human_count
      FROM alerts a
      LEFT JOIN remediation_sessions r ON r.alert_id = a.id
      WHERE a.project_id = ANY(${projectIds})
        AND a.is_resolved = true
        AND a.resolved_at IS NOT NULL
        AND a.created_at >= ${ninetyDaysAgo}
    `),

    // 6. Weekly trend (last 12 weeks)
    db.execute<{ week: string; total: number; completed: number; success_rate: number }>(sql`
      SELECT
        to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        CASE WHEN count(*) > 0
          THEN round(count(*) FILTER (WHERE status = 'completed')::numeric / count(*) * 100)
          ELSE 0
        END::int AS success_rate
      FROM remediation_sessions
      WHERE project_id = ANY(${projectIds})
        AND created_at >= ${ninetyDaysAgo}
      GROUP BY week ORDER BY week
    `),
  ]);

  const overall = overallRaw.rows[0];
  const perDay = perDayRaw.rows;
  const byStatus = byStatusRaw.rows;
  const gateStats = gateStatsRaw.rows[0];
  const mttr = mttrRaw.rows[0];
  const weeklyTrend = weeklyTrendRaw.rows;

  return { overall, perDay, byStatus, gateStats, mttr, weeklyTrend };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function AIMetricsPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login");

  const activeOrgId = await getActiveOrgId();
  const projectIds = await getWorkspaceProjectIds(userId, activeOrgId);

  if (projectIds.length === 0) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-12">
        <p className="text-fg-base/60">No projects found. Create a project to see AI metrics.</p>
      </div>
    );
  }

  const { overall, perDay, byStatus, gateStats, mttr, weeklyTrend } = await getAIMetrics(projectIds);

  const successRate = overall.total > 0 ? Math.round((overall.completed / overall.total) * 100) : 0;
  const autoMergeRate = overall.completed > 0 ? Math.round((overall.auto_merged / overall.completed) * 100) : 0;
  const postDeployPassRate = (overall.monitoring_passed + overall.monitoring_reverted) > 0
    ? Math.round((overall.monitoring_passed / (overall.monitoring_passed + overall.monitoring_reverted)) * 100) : 0;

  const BAR_H = 80;
  const maxDay = Math.max(...perDay.map((d) => d.total), 1);
  const maxWeek = Math.max(...weeklyTrend.map((w) => w.total), 1);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 text-sm text-fg-base/60 mb-1">
            <Link href="/analytics" className="hover:text-fg-base transition-colors">Analytics</Link>
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
            <span className="text-fg-base">AI Metrics</span>
          </div>
          <h1 className="text-2xl font-bold text-fg-strong flex items-center gap-2">
            <Brain className="h-6 w-6 text-inari-accent" aria-hidden="true" />
            AI Performance Metrics
          </h1>
          <p className="text-sm text-fg-base/60 mt-1">Last 30 days — how well the AI pipeline is performing</p>
        </div>
      </div>

      {overall.total === 0 ? (
        <div className="rounded-xl border border-line bg-surface-1 p-12 text-center">
          <Brain className="h-10 w-10 text-fg-base/30 mx-auto mb-4" aria-hidden="true" />
          <p className="text-fg-base font-medium">No AI remediations yet</p>
          <p className="text-sm text-fg-base/60 mt-1">Trigger a fix on an alert to see metrics here.</p>
        </div>
      ) : (
        <>
          {/* ── KPI Cards ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <KPI
              icon={<Target className="h-4 w-4" aria-hidden="true" />}
              label="Success Rate"
              value={`${successRate}%`}
              detail={`${overall.completed} of ${overall.total} fixes succeeded`}
              accent={successRate >= 80 ? "good" : successRate >= 50 ? "warn" : "bad"}
            />
            <KPI
              icon={<GitMerge className="h-4 w-4" aria-hidden="true" />}
              label="Auto-Merge Rate"
              value={`${autoMergeRate}%`}
              detail={`${overall.auto_merged} auto-merged, ${overall.draft_pr} draft PRs`}
              accent={autoMergeRate >= 50 ? "good" : "neutral"}
            />
            <KPI
              icon={<Shield className="h-4 w-4" aria-hidden="true" />}
              label="Post-Deploy Pass"
              value={postDeployPassRate > 0 ? `${postDeployPassRate}%` : "—"}
              detail={`${overall.monitoring_passed} passed, ${overall.monitoring_reverted} reverted`}
              accent={postDeployPassRate >= 90 ? "good" : postDeployPassRate >= 70 ? "warn" : "neutral"}
            />
            <KPI
              icon={<Brain className="h-4 w-4" aria-hidden="true" />}
              label="Avg Confidence"
              value={`${overall.avg_confidence}%`}
              detail={`${overall.with_tests} fixes included regression tests`}
              accent={overall.avg_confidence >= 70 ? "good" : overall.avg_confidence >= 50 ? "warn" : "bad"}
            />
          </div>

          {/* ── MTTR Comparison ───────────────────────────────────────────── */}
          {(mttr.ai_count > 0 || mttr.human_count > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              <div className="rounded-xl border border-line bg-surface-1 p-5">
                <div className="flex items-center gap-2 text-sm text-fg-base/60 mb-3">
                  <Clock className="h-4 w-4" aria-hidden="true" />
                  MTTR — Human (manual resolution)
                </div>
                <p className="text-3xl font-bold text-fg-strong">
                  {mttr.human_mttr_sec > 0 ? duration(mttr.human_mttr_sec) : "—"}
                </p>
                <p className="text-xs text-fg-base/60 mt-1">{mttr.human_count} alerts resolved manually</p>
              </div>
              <div className="rounded-xl border border-inari-accent/30 bg-inari-accent/5 p-5">
                <div className="flex items-center gap-2 text-sm text-inari-accent mb-3">
                  <Zap className="h-4 w-4" aria-hidden="true" />
                  MTTR — AI (automated fixes)
                </div>
                <p className="text-3xl font-bold text-inari-accent">
                  {mttr.ai_mttr_sec > 0 ? duration(mttr.ai_mttr_sec) : "—"}
                </p>
                <p className="text-xs text-fg-base/60 mt-1">
                  {mttr.ai_count} alerts fixed by AI
                  {mttr.human_mttr_sec > 0 && mttr.ai_mttr_sec > 0 && mttr.human_mttr_sec > mttr.ai_mttr_sec && (
                    <span className="ml-2 text-green-600 dark:text-green-400 font-medium">
                      {Math.round(mttr.human_mttr_sec / mttr.ai_mttr_sec)}x faster
                    </span>
                  )}
                </p>
              </div>
            </div>
          )}

          {/* ── Daily Activity Chart ──────────────────────────────────────── */}
          <div className="rounded-xl border border-line bg-surface-1 p-5 mb-8">
            <h2 className="text-sm font-medium text-fg-base mb-4 flex items-center gap-2">
              <Activity className="h-4 w-4 text-fg-base/50" aria-hidden="true" />
              Daily Remediation Activity (30 days)
            </h2>
            <div className="flex items-end gap-[3px]">
              {perDay.map((d) => {
                const completedH = (d.completed / maxDay) * BAR_H;
                const failedH = (d.failed / maxDay) * BAR_H;
                const otherH = ((d.total - d.completed - d.failed) / maxDay) * BAR_H;
                return (
                  <div key={d.day} className="flex flex-1 flex-col items-center group relative" title={`${d.day}: ${d.total} total, ${d.completed} completed, ${d.failed} failed`}>
                    <div className="flex w-full flex-col-reverse" style={{ height: `${BAR_H}px` }}>
                      {completedH > 0 && <div className="w-full rounded-t-sm bg-green-500/70" style={{ height: `${completedH}px` }} />}
                      {failedH > 0 && <div className="w-full bg-red-400/70" style={{ height: `${failedH}px` }} />}
                      {otherH > 0 && <div className="w-full bg-fg-base/20" style={{ height: `${otherH}px` }} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-4 mt-3 text-xs text-fg-base/60">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/70" /> Completed</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-400/70" /> Failed</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-fg-base/20" /> Other</span>
            </div>
          </div>

          {/* ── Weekly Success Rate Trend ─────────────────────────────────── */}
          {weeklyTrend.length > 1 && (
            <div className="rounded-xl border border-line bg-surface-1 p-5 mb-8">
              <h2 className="text-sm font-medium text-fg-base mb-4 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-fg-base/50" aria-hidden="true" />
                Weekly Success Rate Trend (12 weeks)
              </h2>
              <div className="flex items-end gap-2">
                {weeklyTrend.map((w) => {
                  const h = (w.total / maxWeek) * BAR_H;
                  const isGood = w.success_rate >= 80;
                  return (
                    <div key={w.week} className="flex flex-1 flex-col items-center" title={`Week of ${w.week}: ${w.success_rate}% success (${w.completed}/${w.total})`}>
                      <div className="text-[10px] text-fg-base/40 mb-1">{w.success_rate}%</div>
                      <div className="flex w-full flex-col justify-end" style={{ height: `${BAR_H}px` }}>
                        <div
                          className={`w-full rounded-t-sm ${isGood ? "bg-green-500/70" : "bg-amber-400/70"}`}
                          style={{ height: `${h}px` }}
                        />
                      </div>
                      <div className="text-[10px] text-fg-base/40 mt-1">{w.week.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Gate Pass Rates ───────────────────────────────────────────── */}
          {gateStats.total_with_gates > 0 && (
            <div className="rounded-xl border border-line bg-surface-1 p-5 mb-8">
              <h2 className="text-sm font-medium text-fg-base mb-4 flex items-center gap-2">
                <Shield className="h-4 w-4 text-fg-base/50" aria-hidden="true" />
                Safety Gate Pass Rates
              </h2>
              <div className="space-y-3">
                <GateBar label="CI Pass" value={gateStats.ci_passed} total={gateStats.total_with_gates} />
                <GateBar label="Self-Review (score >= 70)" value={gateStats.self_review_passed} total={gateStats.total_with_gates} />
                <GateBar label="Confidence (>= 60%)" value={gateStats.security_passed} total={gateStats.total_with_gates} />
                <GateBar label="Substrate Simulate (<= 40 risk)" value={gateStats.substrate_passed} total={gateStats.total_with_gates} />
              </div>
            </div>
          )}

          {/* ── Status Breakdown ──────────────────────────────────────────── */}
          <div className="rounded-xl border border-line bg-surface-1 p-5">
            <h2 className="text-sm font-medium text-fg-base mb-4">Status Distribution</h2>
            <div className="space-y-2">
              {byStatus.map((s) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-xs text-fg-base/60 w-32 truncate font-mono">{s.status}</span>
                  <div className="flex-1 bg-surface-inner rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${
                        s.status === "completed" ? "bg-green-500" :
                        s.status === "failed" ? "bg-red-400" :
                        s.status === "cancelled" ? "bg-fg-base/30" :
                        "bg-inari-accent/60"
                      }`}
                      style={{ width: `${Math.max((s.count / overall.total) * 100, 2)}%` }}
                    />
                  </div>
                  <span className="text-xs text-fg-base/60 w-16 text-right">{s.count} ({pct(s.count, overall.total)})</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KPI({ icon, label, value, detail, accent }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  accent: "good" | "warn" | "bad" | "neutral";
}) {
  const border = accent === "good" ? "border-green-500/20"
    : accent === "warn" ? "border-amber-500/20"
    : accent === "bad" ? "border-red-500/20"
    : "border-line";
  const bg = accent === "good" ? "bg-green-500/5"
    : accent === "warn" ? "bg-amber-500/5"
    : accent === "bad" ? "bg-red-500/5"
    : "bg-surface-1";
  const valueColor = accent === "good" ? "text-green-600 dark:text-green-400"
    : accent === "warn" ? "text-amber-600 dark:text-amber-400"
    : accent === "bad" ? "text-red-600 dark:text-red-400"
    : "text-fg-strong";

  return (
    <div className={`rounded-xl border ${border} ${bg} px-4 py-4`}>
      <div className="flex items-center gap-1.5 text-xs text-fg-base/60 mb-2">
        {icon}
        {label}
      </div>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
      <p className="text-xs text-fg-base/60 mt-1">{detail}</p>
    </div>
  );
}

function GateBar({ label, value, total }: { label: string; value: number; total: number }) {
  const rate = total > 0 ? Math.round((value / total) * 100) : 0;
  const isGood = rate >= 80;

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-fg-base/60 w-44 truncate">{label}</span>
      <div className="flex-1 bg-surface-inner rounded-full h-2.5">
        <div
          className={`h-2.5 rounded-full transition-all ${isGood ? "bg-green-500" : "bg-amber-400"}`}
          style={{ width: `${Math.max(rate, 2)}%` }}
        />
      </div>
      <span className={`text-xs font-medium w-12 text-right ${isGood ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
        {rate}%
      </span>
    </div>
  );
}
