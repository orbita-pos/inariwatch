import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, getUserProjectIds } from "@/lib/db";
import { eq, inArray, and, gte, sql } from "drizzle-orm";
import { BarChart3 } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Analytics" };

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-violet-500",
  warning:  "bg-amber-400",
  info:     "bg-blue-400",
};

const SEVERITY_BAR_COLORS: Record<string, string> = {
  critical: "bg-violet-500/60",
  warning:  "bg-amber-400/60",
  info:     "bg-blue-400/60",
};

const SEVERITY_LABEL_COLORS: Record<string, string> = {
  critical: "text-violet-400",
  warning:  "text-amber-400",
  info:     "text-blue-400",
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function AnalyticsPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const projectIds = userId ? await getUserProjectIds(userId) : [];

  // 14 days ago at midnight
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  fourteenDaysAgo.setHours(0, 0, 0, 0);

  // ── Queries ──────────────────────────────────────────────────────────────

  const hasProjects = projectIds.length > 0;

  // Alerts per day grouped by severity
  const perDayRaw = hasProjects
    ? await db
        .select({
          day: sql<string>`date_trunc('day', ${alerts.createdAt})::date`.as("day"),
          severity: alerts.severity,
          count: sql<number>`count(*)`.as("count"),
        })
        .from(alerts)
        .where(
          and(
            inArray(alerts.projectId, projectIds),
            gte(alerts.createdAt, fourteenDaysAgo)
          )
        )
        .groupBy(sql`date_trunc('day', ${alerts.createdAt})::date`, alerts.severity)
        .orderBy(sql`date_trunc('day', ${alerts.createdAt})::date`)
    : [];

  // Total alerts in range
  const totalRow = hasProjects
    ? await db
        .select({ count: sql<number>`count(*)`.as("count") })
        .from(alerts)
        .where(
          and(
            inArray(alerts.projectId, projectIds),
            gte(alerts.createdAt, fourteenDaysAgo)
          )
        )
    : [{ count: 0 }];
  const totalAlerts = Number(totalRow[0]?.count ?? 0);

  // Critical count
  const criticalRow = hasProjects
    ? await db
        .select({ count: sql<number>`count(*)`.as("count") })
        .from(alerts)
        .where(
          and(
            inArray(alerts.projectId, projectIds),
            gte(alerts.createdAt, fourteenDaysAgo),
            eq(alerts.severity, "critical")
          )
        )
    : [{ count: 0 }];
  const criticalCount = Number(criticalRow[0]?.count ?? 0);

  // Resolved count (for resolution rate)
  const resolvedRow = hasProjects
    ? await db
        .select({ count: sql<number>`count(*)`.as("count") })
        .from(alerts)
        .where(
          and(
            inArray(alerts.projectId, projectIds),
            gte(alerts.createdAt, fourteenDaysAgo),
            eq(alerts.isResolved, true)
          )
        )
    : [{ count: 0 }];
  const resolvedCount = Number(resolvedRow[0]?.count ?? 0);
  const resolutionRate = totalAlerts > 0 ? Math.round((resolvedCount / totalAlerts) * 100) : 0;

  // Avg per day
  const avgPerDay = totalAlerts > 0 ? (totalAlerts / 14).toFixed(1) : "0";

  // By source
  const sourceRaw = hasProjects
    ? await db
        .select({
          source: sql<string>`unnest(${alerts.sourceIntegrations})`.as("source"),
          count: sql<number>`count(*)`.as("count"),
        })
        .from(alerts)
        .where(
          and(
            inArray(alerts.projectId, projectIds),
            gte(alerts.createdAt, fourteenDaysAgo)
          )
        )
        .groupBy(sql`unnest(${alerts.sourceIntegrations})`)
        .orderBy(sql`count(*) desc`)
        .limit(6)
    : [];

  // By severity (overall distribution)
  const severityDist = hasProjects
    ? await db
        .select({
          severity: alerts.severity,
          count: sql<number>`count(*)`.as("count"),
        })
        .from(alerts)
        .where(
          and(
            inArray(alerts.projectId, projectIds),
            gte(alerts.createdAt, fourteenDaysAgo)
          )
        )
        .groupBy(alerts.severity)
        .orderBy(sql`count(*) desc`)
    : [];

  // ── Build chart data ─────────────────────────────────────────────────────

  // Generate all 14 days
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Build map: { "2026-03-01": { critical: 2, warning: 1, info: 3 } }
  const dayMap: Record<string, Record<string, number>> = {};
  for (const day of days) {
    dayMap[day] = { critical: 0, warning: 0, info: 0 };
  }
  for (const row of perDayRaw) {
    const dayKey = String(row.day).slice(0, 10);
    if (dayMap[dayKey]) {
      dayMap[dayKey][row.severity] = Number(row.count);
    }
  }

  // Max count for scaling
  const maxDayCount = Math.max(
    1,
    ...days.map((d) => {
      const counts = dayMap[d];
      return (counts.critical ?? 0) + (counts.warning ?? 0) + (counts.info ?? 0);
    })
  );

  const BAR_MAX_HEIGHT = 160;

  // Source max for horizontal bars
  const maxSourceCount = Math.max(1, ...sourceRaw.map((s) => Number(s.count)));

  // Severity distribution max
  const maxSevCount = Math.max(1, ...severityDist.map((s) => Number(s.count)));
  const totalSevCount = severityDist.reduce((sum, s) => sum + Number(s.count), 0);

  // ── Empty state ──────────────────────────────────────────────────────────

  if (!hasProjects || totalAlerts === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-zinc-500">Alert trends over the last 14 days</p>
        </div>
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[#1a1a1a] py-16 text-center">
          <BarChart3 className="h-5 w-5 text-zinc-700" />
          <p className="text-sm font-medium text-zinc-500">No data yet</p>
          <p className="text-sm text-zinc-600">
            {!hasProjects ? (
              <>
                <Link
                  href="/integrations"
                  className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
                >
                  Connect an integration
                </Link>{" "}
                to start generating analytics.
              </>
            ) : (
              "Alerts will appear here once your integrations start reporting."
            )}
          </p>
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-white tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-zinc-500">Alert trends over the last 14 days</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex flex-col gap-1 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-5 py-4">
          <span className="text-xs text-zinc-500">Total Alerts</span>
          <span className="text-2xl font-semibold tabular-nums text-white">{totalAlerts}</span>
          <span className="text-xs text-zinc-600">last 14 days</span>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-5 py-4">
          <span className="text-xs text-zinc-500">Critical</span>
          <span className={`text-2xl font-semibold tabular-nums ${criticalCount > 0 ? "text-inari-accent" : "text-white"}`}>
            {criticalCount}
          </span>
          <span className="text-xs text-zinc-600">high severity</span>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-5 py-4">
          <span className="text-xs text-zinc-500">Avg / Day</span>
          <span className="text-2xl font-semibold tabular-nums text-white">{avgPerDay}</span>
          <span className="text-xs text-zinc-600">average daily</span>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-5 py-4">
          <span className="text-xs text-zinc-500">Resolution Rate</span>
          <span className={`text-2xl font-semibold tabular-nums ${resolutionRate >= 80 ? "text-green-400" : resolutionRate >= 50 ? "text-amber-400" : "text-white"}`}>
            {resolutionRate}%
          </span>
          <span className="text-xs text-zinc-600">{resolvedCount} of {totalAlerts} resolved</span>
        </div>
      </div>

      {/* Bar chart */}
      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-200">Alerts per day</h2>
          <div className="flex items-center gap-3">
            {(["critical", "warning", "info"] as const).map((sev) => (
              <div key={sev} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${SEVERITY_COLORS[sev]}`} />
                <span className="text-xs text-zinc-500 capitalize">{sev}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-end gap-1.5" style={{ height: `${BAR_MAX_HEIGHT + 40}px` }}>
          {days.map((day) => {
            const counts = dayMap[day];
            const total = counts.critical + counts.warning + counts.info;
            const critH = total > 0 ? (counts.critical / maxDayCount) * BAR_MAX_HEIGHT : 0;
            const warnH = total > 0 ? (counts.warning / maxDayCount) * BAR_MAX_HEIGHT : 0;
            const infoH = total > 0 ? (counts.info / maxDayCount) * BAR_MAX_HEIGHT : 0;
            const barH = critH + warnH + infoH;

            return (
              <div key={day} className="flex flex-1 flex-col items-center gap-1.5">
                {/* Count label */}
                <span className="text-[10px] tabular-nums text-zinc-600">
                  {total > 0 ? total : ""}
                </span>

                {/* Stacked bar */}
                <div
                  className="flex w-full flex-col justify-end rounded-t overflow-hidden"
                  style={{ height: `${BAR_MAX_HEIGHT}px` }}
                >
                  <div className="flex flex-col-reverse w-full">
                    {infoH > 0 && (
                      <div
                        className="w-full bg-blue-400/80"
                        style={{ height: `${infoH}px` }}
                      />
                    )}
                    {warnH > 0 && (
                      <div
                        className="w-full bg-amber-400/80"
                        style={{ height: `${warnH}px` }}
                      />
                    )}
                    {critH > 0 && (
                      <div
                        className="w-full bg-violet-500/80"
                        style={{ height: `${critH}px` }}
                      />
                    )}
                  </div>
                  {barH === 0 && (
                    <div className="w-full rounded-t bg-white/[0.03]" style={{ height: "2px" }} />
                  )}
                </div>

                {/* Date label */}
                <span className="text-[10px] text-zinc-600 whitespace-nowrap">
                  {formatShortDate(day)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Two-column breakdown */}
      <div className="grid gap-3 md:grid-cols-2">

        {/* By source */}
        <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-5">
          <h2 className="mb-4 text-sm font-medium text-zinc-200">By source</h2>
          {sourceRaw.length === 0 ? (
            <p className="text-sm text-zinc-600">No source data available.</p>
          ) : (
            <div className="space-y-3">
              {sourceRaw.map((src) => {
                const pct = (Number(src.count) / maxSourceCount) * 100;
                return (
                  <div key={src.source} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-zinc-300 capitalize">{src.source}</span>
                      <span className="font-mono text-xs tabular-nums text-zinc-500">{src.count}</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-white/[0.04]">
                      <div
                        className="h-2 rounded-full bg-inari-accent/60"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* By severity */}
        <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-5">
          <h2 className="mb-4 text-sm font-medium text-zinc-200">By severity</h2>
          {severityDist.length === 0 ? (
            <p className="text-sm text-zinc-600">No severity data available.</p>
          ) : (
            <div className="space-y-3">
              {(["critical", "warning", "info"] as const).map((sev) => {
                const row = severityDist.find((s) => s.severity === sev);
                const sevCount = Number(row?.count ?? 0);
                const pct = totalSevCount > 0 ? (sevCount / totalSevCount) * 100 : 0;
                return (
                  <div key={sev} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${SEVERITY_COLORS[sev]}`} />
                        <span className={`text-sm capitalize ${SEVERITY_LABEL_COLORS[sev]}`}>{sev}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs tabular-nums text-zinc-500">{sevCount}</span>
                        <span className="font-mono text-[10px] tabular-nums text-zinc-600">
                          ({pct.toFixed(0)}%)
                        </span>
                      </div>
                    </div>
                    <div className="h-2 w-full rounded-full bg-white/[0.04]">
                      <div
                        className={`h-2 rounded-full ${SEVERITY_BAR_COLORS[sev]}`}
                        style={{ width: `${(sevCount / maxSevCount) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
