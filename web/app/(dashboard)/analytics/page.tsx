import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, remediationSessions, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { inArray, and, gte, eq, sql, isNotNull } from "drizzle-orm";
import { BarChart3, ArrowUpRight, Zap, DollarSign } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Analytics" };

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const SEV_DOT: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-400",
  info:     "bg-blue-400",
};
const SEV_TEXT: Record<string, string> = {
  critical: "text-inari-accent",
  warning:  "text-amber-600 dark:text-amber-400",
  info:     "text-blue-600 dark:text-blue-400",
};
const SEV_BAR_COLOR: Record<string, string> = {
  critical: "bg-inari-accent/70",
  warning:  "bg-amber-400/70",
  info:     "bg-blue-400/70",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AnalyticsPage() {
  const session   = await getServerSession(authOptions);
  const userId    = (session?.user as { id?: string })?.id;

  const projectIds = userId ? await getWorkspaceProjectIds(userId, await getActiveOrgId()) : [];
  const hasProjects = projectIds.length > 0;

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  fourteenDaysAgo.setHours(0, 0, 0, 0);

  const baseWhere = hasProjects
    ? and(inArray(alerts.projectId, projectIds), gte(alerts.createdAt, fourteenDaysAgo))
    : undefined;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Parallel fetch all analytics queries — eliminates 5-query waterfall
  const [perDayRaw, totalRow, criticalRow, resolvedRow, sourceRaw, severityDist, remStats, humanMttrRaw, aiMttrRaw] = hasProjects
    ? await Promise.all([
        db.select({
          day:      sql<string>`date_trunc('day', ${alerts.createdAt})::date`.as("day"),
          severity: alerts.severity,
          count:    sql<number>`count(*)`.as("count"),
        })
          .from(alerts)
          .where(baseWhere)
          .groupBy(sql`date_trunc('day', ${alerts.createdAt})::date`, alerts.severity)
          .orderBy(sql`date_trunc('day', ${alerts.createdAt})::date`),

        db.select({ count: sql<number>`count(*)`.as("count") })
          .from(alerts).where(baseWhere),

        db.select({ count: sql<number>`count(*)`.as("count") })
          .from(alerts).where(and(baseWhere, eq(alerts.severity, "critical"))),

        db.select({ count: sql<number>`count(*)`.as("count") })
          .from(alerts).where(and(baseWhere, eq(alerts.isResolved, true))),

        db.select({
          source: sql<string>`unnest(${alerts.sourceIntegrations})`.as("source"),
          count:  sql<number>`count(*)`.as("count"),
        })
          .from(alerts)
          .where(baseWhere)
          .groupBy(sql`unnest(${alerts.sourceIntegrations})`)
          .orderBy(sql`count(*) desc`)
          .limit(6),

        db.select({ severity: alerts.severity, count: sql<number>`count(*)`.as("count") })
          .from(alerts)
          .where(baseWhere)
          .groupBy(alerts.severity)
          .orderBy(sql`count(*) desc`),

        db.select({
          total:          sql<number>`count(*)`.as("total"),
          approved:       sql<number>`count(*) filter (where status = 'completed')`.as("approved"),
          autoMerged:     sql<number>`count(*) filter (where merge_strategy = 'auto_merged' and status = 'completed')`.as("auto_merged"),
          cancelled:      sql<number>`count(*) filter (where status = 'cancelled')`.as("cancelled"),
          passed:         sql<number>`count(*) filter (where monitoring_status = 'passed')`.as("passed"),
          reverted:       sql<number>`count(*) filter (where monitoring_status = 'reverted')`.as("reverted"),
          avgConfidence:  sql<number>`round(avg(confidence_score) filter (where confidence_score is not null))`.as("avg_confidence"),
          avgDecideSec:   sql<number>`round(avg(extract(epoch from (updated_at - proposed_at))) filter (where proposed_at is not null and status in ('completed','cancelled')))`.as("avg_decide_sec"),
        })
          .from(remediationSessions)
          .where(and(
            inArray(remediationSessions.projectId, projectIds),
            gte(remediationSessions.createdAt, thirtyDaysAgo),
          )),

        // Human MTTR — alerts resolved manually (no completed AI session)
        db.select({
          avgSec: sql<number>`round(avg(extract(epoch from (resolved_at - created_at))))`.as("avg_sec"),
          count:  sql<number>`count(*)`.as("count"),
        })
          .from(alerts)
          .where(and(
            inArray(alerts.projectId, projectIds),
            eq(alerts.isResolved, true),
            isNotNull(alerts.resolvedAt),
            gte(alerts.createdAt, thirtyDaysAgo),
            sql`alerts.id not in (select distinct alert_id from remediation_sessions where status = 'completed')`,
          )),

        // AI MTTR — alerts resolved via a completed AI remediation session
        db.select({
          avgSec: sql<number>`round(avg(extract(epoch from (resolved_at - created_at))))`.as("avg_sec"),
          count:  sql<number>`count(*)`.as("count"),
        })
          .from(alerts)
          .where(and(
            inArray(alerts.projectId, projectIds),
            eq(alerts.isResolved, true),
            isNotNull(alerts.resolvedAt),
            gte(alerts.createdAt, thirtyDaysAgo),
            sql`alerts.id in (select distinct alert_id from remediation_sessions where status = 'completed')`,
          )),
      ])
    : [[], [{ count: 0 }], [{ count: 0 }], [{ count: 0 }], [], [], [], [{ avgSec: 0, count: 0 }], [{ avgSec: 0, count: 0 }]];

  const rem            = remStats[0];
  const remTotal       = Number(rem?.total ?? 0);
  const remApproved    = Number(rem?.approved ?? 0);
  const remCancelled   = Number(rem?.cancelled ?? 0);
  const remAutoMerged  = Number(rem?.autoMerged ?? 0);
  const remPassed      = Number(rem?.passed ?? 0);
  const remReverted    = Number(rem?.reverted ?? 0);
  const remAvgConf     = Number(rem?.avgConfidence ?? 0);
  const remAvgDecSec   = Number(rem?.avgDecideSec ?? 0);
  const approvalRate   = remTotal > 0 ? Math.round((remApproved / remTotal) * 100) : 0;
  const successRate    = (remPassed + remReverted) > 0 ? Math.round((remPassed / (remPassed + remReverted)) * 100) : null;
  const avgDecideMin   = remAvgDecSec > 0 ? (remAvgDecSec / 60).toFixed(1) : null;

  const humanMttrSec   = Number(humanMttrRaw[0]?.avgSec ?? 0);
  const humanMttrCount = Number(humanMttrRaw[0]?.count ?? 0);
  const aiMttrSec      = Number(aiMttrRaw[0]?.avgSec ?? 0);
  const aiMttrCount    = Number(aiMttrRaw[0]?.count ?? 0);
  const speedupFactor  = humanMttrSec > 0 && aiMttrSec > 0 ? Math.round(humanMttrSec / aiMttrSec) : null;

  const ENGINEER_RATE_PER_HOUR = 150;
  const hoursSaved  = humanMttrSec > 0 && aiMttrSec > 0 && humanMttrSec > aiMttrSec
    ? aiMttrCount * (humanMttrSec - aiMttrSec) / 3600
    : 0;
  const costSaved   = Math.round(hoursSaved * ENGINEER_RATE_PER_HOUR);

  const totalAlerts    = Number(totalRow[0]?.count ?? 0);
  const criticalCount  = Number(criticalRow[0]?.count ?? 0);
  const resolvedCount  = Number(resolvedRow[0]?.count ?? 0);
  const resolutionRate = totalAlerts > 0 ? Math.round((resolvedCount / totalAlerts) * 100) : 0;
  const avgPerDay      = totalAlerts > 0 ? (totalAlerts / 14).toFixed(1) : "0";

  // ── Build chart data ──────────────────────────────────────────────────────

  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const dayMap: Record<string, Record<string, number>> = {};
  for (const day of days) dayMap[day] = { critical: 0, warning: 0, info: 0 };
  for (const row of perDayRaw) {
    const dayKey = String(row.day).slice(0, 10);
    if (dayMap[dayKey]) dayMap[dayKey][row.severity] = Number(row.count);
  }

  const maxDayCount = Math.max(1, ...days.map((d) => {
    const c = dayMap[d];
    return (c.critical ?? 0) + (c.warning ?? 0) + (c.info ?? 0);
  }));

  const BAR_MAX_HEIGHT = 140;
  const maxSourceCount = Math.max(1, ...sourceRaw.map((s) => Number(s.count)));
  const maxSevCount    = Math.max(1, ...severityDist.map((s) => Number(s.count)));
  const totalSevCount  = severityDist.reduce((sum, s) => sum + Number(s.count), 0);

  // ── Empty state ───────────────────────────────────────────────────────────

  if (!hasProjects || totalAlerts === 0) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-16 text-center">
          <BarChart3 className="h-5 w-5 text-fg-base/30" aria-hidden="true" />
          <p className="text-sm font-medium text-fg-base/60">No data yet</p>
          <p className="text-sm text-fg-base/50">
            {!hasProjects ? (
              <>
                <Link href="/onboarding" className="text-fg-base/60 underline underline-offset-2 transition-colors hover:text-fg-strong">
                  Import a repo from GitHub
                </Link>{" "}
                to start generating analytics.
              </>
            ) : (
              "Alerts will appear here once Capture or webhooks start reporting."
            )}
          </p>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total"          value={String(totalAlerts)}  description="last 14 days" />
        <StatCard label="Critical"       value={String(criticalCount)} description="high severity" accent={criticalCount > 0 ? "critical" : undefined} />
        <StatCard label="Avg / day"      value={avgPerDay}            description="daily average" />
        <StatCard label="Resolution"     value={`${resolutionRate}%`} description={`${resolvedCount} of ${totalAlerts} resolved`}
          accent={resolutionRate >= 80 ? "good" : resolutionRate >= 50 ? "warning" : undefined} />
      </div>

      {/* Bar chart */}
      <section className="overflow-hidden rounded-xl border border-line bg-surface p-5">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-base">Alerts per day</h2>
          <div className="flex items-center gap-4">
            {(["critical", "warning", "info"] as const).map((sev) => (
              <div key={sev} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${SEV_DOT[sev]}`} />
                <span className="text-xs capitalize text-fg-base/60">{sev}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-end gap-1" style={{ height: `${BAR_MAX_HEIGHT + 36}px` }}>
          {days.map((day) => {
            const counts = dayMap[day];
            const total  = counts.critical + counts.warning + counts.info;
            const critH  = total > 0 ? (counts.critical / maxDayCount) * BAR_MAX_HEIGHT : 0;
            const warnH  = total > 0 ? (counts.warning  / maxDayCount) * BAR_MAX_HEIGHT : 0;
            const infoH  = total > 0 ? (counts.info     / maxDayCount) * BAR_MAX_HEIGHT : 0;
            const barH   = critH + warnH + infoH;

            return (
              <div key={day} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] tabular-nums text-fg-base/40">
                  {total > 0 ? total : ""}
                </span>
                <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: `${BAR_MAX_HEIGHT}px` }}>
                  <div className="flex w-full flex-col-reverse">
                    {infoH > 0 && <div className="w-full bg-blue-400/70"  style={{ height: `${infoH}px` }} />}
                    {warnH > 0 && <div className="w-full bg-amber-400/70" style={{ height: `${warnH}px` }} />}
                    {critH > 0 && <div className="w-full bg-inari-accent/70" style={{ height: `${critH}px` }} />}
                  </div>
                  {barH === 0 && <div className="w-full rounded-t bg-black/[0.04] dark:bg-white/[0.03]" style={{ height: "2px" }} />}
                </div>
                <span className="text-[10px] whitespace-nowrap text-fg-base/40">{formatShortDate(day)}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Two-col breakdown */}
      <div className="grid gap-3 md:grid-cols-2">

        {/* By source */}
        <section className="overflow-hidden rounded-xl border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-fg-base">By source</h2>
          {sourceRaw.length === 0 ? (
            <p className="text-sm text-fg-base/50">No source data available.</p>
          ) : (
            <div className="space-y-3">
              {sourceRaw.map((src) => {
                const pct = (Number(src.count) / maxSourceCount) * 100;
                return (
                  <div key={src.source} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm capitalize text-fg-base">{src.source}</span>
                      <span className="font-mono text-xs tabular-nums text-fg-base/60">{src.count}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.06]">
                      <div className="h-1.5 rounded-full bg-inari-accent/50" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* By severity */}
        <section className="overflow-hidden rounded-xl border border-line bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold text-fg-base">By severity</h2>
          {severityDist.length === 0 ? (
            <p className="text-sm text-fg-base/50">No severity data available.</p>
          ) : (
            <div className="space-y-3">
              {(["critical", "warning", "info"] as const).map((sev) => {
                const row      = severityDist.find((s) => s.severity === sev);
                const sevCount = Number(row?.count ?? 0);
                const pct      = totalSevCount > 0 ? (sevCount / totalSevCount) * 100 : 0;
                return (
                  <div key={sev} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${SEV_DOT[sev]}`} />
                        <span className={`text-sm capitalize ${SEV_TEXT[sev]}`}>{sev}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs tabular-nums text-fg-base/60">{sevCount}</span>
                        <span className="font-mono text-[10px] tabular-nums text-fg-base/40">{pct.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.06]">
                      <div
                        className={`h-1.5 rounded-full ${SEV_BAR_COLOR[sev]}`}
                        style={{ width: `${(sevCount / maxSevCount) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {/* AI Remediation */}
      {remTotal > 0 && (
        <section className="overflow-hidden rounded-xl border border-line bg-surface p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-base">AI Remediation</h2>
            <div className="flex items-center gap-4">
              <Link href="/analytics/ai-usage" className="text-xs text-inari-accent hover:text-inari-accent/80 transition-colors flex items-center gap-1">
                BYOK usage <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
              <Link href="/analytics/ai" className="text-xs text-inari-accent hover:text-inari-accent/80 transition-colors flex items-center gap-1">
                Full AI metrics <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Remediations"  value={String(remTotal)}        sub="started" />
            <MiniStat label="Approval rate" value={`${approvalRate}%`}      sub={`${remApproved} approved`}
              accent={approvalRate >= 70 ? "good" : approvalRate >= 40 ? "warn" : undefined} />
            <MiniStat label="Avg confidence" value={remAvgConf > 0 ? `${remAvgConf}` : "—"} sub="AI score 0–100"
              accent={remAvgConf >= 80 ? "good" : remAvgConf >= 50 ? "warn" : undefined} />
            <MiniStat label="Avg decide time" value={avgDecideMin ? `${avgDecideMin}m` : "—"} sub="proposing → approved" />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 pt-1 border-t border-line-subtle">
            <MiniStat label="Auto-merged"  value={String(remAutoMerged)}  sub="no human click needed" />
            <MiniStat label="Post-deploy"  value={successRate !== null ? `${successRate}%` : "—"} sub="passed monitoring"
              accent={successRate !== null && successRate >= 80 ? "good" : successRate !== null && successRate < 50 ? "warn" : undefined} />
            <MiniStat label="Reverted"     value={String(remReverted)}    sub="auto-reverted after merge"
              accent={remReverted > 0 ? "warn" : undefined} />
            <MiniStat label="Cancelled"    value={String(remCancelled)}   sub="rejected by human" />
          </div>
        </section>
      )}

      {/* MTTR Comparison */}
      {(humanMttrSec > 0 || aiMttrSec > 0) && (
        <section className="overflow-hidden rounded-xl border border-line bg-surface p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-base">Response time comparison</h2>
            <span className="text-xs text-fg-base/60">last 30 days · resolved alerts</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-line bg-surface-dim p-4 space-y-1.5">
              <span className="text-[10px] font-medium uppercase tracking-widest text-fg-base/50">Human</span>
              <div className="font-mono text-3xl font-semibold tabular-nums text-fg-strong">
                {humanMttrSec > 0 ? formatDuration(humanMttrSec) : "—"}
              </div>
              <div className="text-xs text-fg-base/60">avg to resolve manually</div>
              {humanMttrCount > 0 && (
                <div className="text-[11px] text-fg-base/40">{humanMttrCount} alert{humanMttrCount !== 1 ? "s" : ""}</div>
              )}
            </div>

            <div className="rounded-lg border border-violet-300 bg-violet-50/70 dark:border-violet-500/20 dark:bg-violet-950/10 p-4 space-y-1.5">
              <span className="text-[10px] font-medium uppercase tracking-widest text-violet-600 dark:text-violet-500">AI</span>
              <div className="font-mono text-3xl font-semibold tabular-nums text-violet-700 dark:text-violet-300">
                {aiMttrSec > 0 ? formatDuration(aiMttrSec) : "—"}
              </div>
              <div className="text-xs text-fg-base/60">avg with AI remediation</div>
              {aiMttrCount > 0 && (
                <div className="text-[11px] text-fg-base/40">{aiMttrCount} alert{aiMttrCount !== 1 ? "s" : ""}</div>
              )}
            </div>
          </div>

          {speedupFactor !== null && speedupFactor >= 2 && (
            <div className="flex items-center gap-2.5 rounded-lg border border-violet-200 bg-violet-50 dark:border-violet-500/10 dark:bg-violet-950/20 px-4 py-2.5">
              <Zap className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
              <span className="text-sm text-violet-700 dark:text-violet-300">
                AI resolves incidents{" "}
                <span className="font-semibold">{speedupFactor}× faster</span>{" "}
                than manual review
              </span>
            </div>
          )}

          {costSaved > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 dark:border-green-500/10 dark:bg-green-950/20 px-4 py-2.5">
              <div className="flex items-center gap-2.5">
                <DollarSign className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
                <span className="text-sm text-green-700 dark:text-green-300">
                  Estimated engineering cost saved{" "}
                  <span className="text-[11px] text-fg-base/50">· @${ENGINEER_RATE_PER_HOUR}/hr · last 30 days</span>
                </span>
              </div>
              <span className="font-mono text-sm font-semibold tabular-nums text-green-600 dark:text-green-400">
                ${costSaved.toLocaleString()}
              </span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function PageHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-fg-base/60">Alert trends over the last 14 days</p>
      </div>
      <Link
        href="/alerts"
        className="flex shrink-0 items-center gap-1 text-xs text-fg-base/60 transition-colors hover:text-fg-base"
      >
        View alerts <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function MiniStat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: "good" | "warn" }) {
  const valColor = accent === "good" ? "text-green-600 dark:text-green-400" : accent === "warn" ? "text-amber-600 dark:text-amber-400" : "text-fg-strong";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-widest text-fg-base/50">{label}</span>
      <span className={`font-mono text-2xl font-semibold tabular-nums ${valColor}`}>{value}</span>
      <span className="text-[11px] text-fg-base/50">{sub}</span>
    </div>
  );
}

function StatCard({
  label,
  value,
  description,
  accent,
}: {
  label: string;
  value: string;
  description: string;
  accent?: "critical" | "warning" | "good";
}) {
  const numColor =
    accent === "critical" ? "text-inari-accent" :
    accent === "warning"  ? "text-amber-600 dark:text-amber-400" :
    accent === "good"     ? "text-green-600 dark:text-green-400" :
    "text-fg-strong";
  const borderColor =
    accent === "critical" ? "border-inari-accent/20" :
    accent === "warning"  ? "border-amber-500/20" :
    accent === "good"     ? "border-green-500/20" :
    "border-line";
  const bg =
    accent === "critical" ? "bg-inari-accent-dim" :
    accent === "warning"  ? "bg-amber-500/5" :
    accent === "good"     ? "bg-green-500/5" :
    "bg-surface";

  return (
    <div className={`flex flex-col gap-1.5 rounded-xl border ${borderColor} ${bg} px-4 py-4`}>
      <span className="text-[11px] font-medium uppercase tracking-widest text-fg-base/60">{label}</span>
      <span className={`font-mono text-3xl font-semibold leading-none tabular-nums ${numColor}`}>{value}</span>
      <span className="text-xs text-fg-base/50">{description}</span>
    </div>
  );
}
