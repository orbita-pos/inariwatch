import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, getUserProjectIds } from "@/lib/db";
import { inArray, and, gte, eq, sql } from "drizzle-orm";
import { BarChart3, ArrowUpRight } from "lucide-react";
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
  warning:  "text-amber-400",
  info:     "text-blue-400",
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
  const projectIds = userId ? await getUserProjectIds(userId) : [];
  const hasProjects = projectIds.length > 0;

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  fourteenDaysAgo.setHours(0, 0, 0, 0);

  const baseWhere = hasProjects
    ? and(inArray(alerts.projectId, projectIds), gte(alerts.createdAt, fourteenDaysAgo))
    : undefined;

  // Parallel fetch all analytics queries — eliminates 5-query waterfall
  const [perDayRaw, totalRow, criticalRow, resolvedRow, sourceRaw, severityDist] = hasProjects
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
      ])
    : [[], [{ count: 0 }], [{ count: 0 }], [{ count: 0 }], [], []];

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
          <BarChart3 className="h-5 w-5 text-zinc-700" />
          <p className="text-sm font-medium text-zinc-500">No data yet</p>
          <p className="text-sm text-zinc-600">
            {!hasProjects ? (
              <>
                <Link href="/integrations" className="text-zinc-400 underline underline-offset-2 transition-colors hover:text-fg-strong">
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
                <span className="text-xs capitalize text-zinc-500">{sev}</span>
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
                <span className="text-[10px] tabular-nums text-zinc-700">
                  {total > 0 ? total : ""}
                </span>
                <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: `${BAR_MAX_HEIGHT}px` }}>
                  <div className="flex w-full flex-col-reverse">
                    {infoH > 0 && <div className="w-full bg-blue-400/70"  style={{ height: `${infoH}px` }} />}
                    {warnH > 0 && <div className="w-full bg-amber-400/70" style={{ height: `${warnH}px` }} />}
                    {critH > 0 && <div className="w-full bg-inari-accent/70" style={{ height: `${critH}px` }} />}
                  </div>
                  {barH === 0 && <div className="w-full rounded-t bg-white/[0.03]" style={{ height: "2px" }} />}
                </div>
                <span className="text-[10px] whitespace-nowrap text-zinc-700">{formatShortDate(day)}</span>
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
            <p className="text-sm text-zinc-600">No source data available.</p>
          ) : (
            <div className="space-y-3">
              {sourceRaw.map((src) => {
                const pct = (Number(src.count) / maxSourceCount) * 100;
                return (
                  <div key={src.source} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm capitalize text-fg-base">{src.source}</span>
                      <span className="font-mono text-xs tabular-nums text-zinc-500">{src.count}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
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
            <p className="text-sm text-zinc-600">No severity data available.</p>
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
                        <span className="font-mono text-xs tabular-nums text-zinc-500">{sevCount}</span>
                        <span className="font-mono text-[10px] tabular-nums text-zinc-700">{pct.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
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
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function PageHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-zinc-500">Alert trends over the last 14 days</p>
      </div>
      <Link
        href="/alerts"
        className="flex shrink-0 items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-fg-base"
      >
        View alerts <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
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
    accent === "warning"  ? "text-amber-400" :
    accent === "good"     ? "text-green-400" :
    "text-fg-strong";
  const borderColor =
    accent === "critical" ? "border-inari-accent/20" :
    accent === "warning"  ? "border-amber-900/40" :
    accent === "good"     ? "border-green-900/40" :
    "border-line";
  const bg =
    accent === "critical" ? "bg-inari-accent-dim" :
    accent === "warning"  ? "bg-amber-950/20" :
    accent === "good"     ? "bg-green-950/20" :
    "bg-surface";

  return (
    <div className={`flex flex-col gap-1.5 rounded-xl border ${borderColor} ${bg} px-4 py-4`}>
      <span className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">{label}</span>
      <span className={`font-mono text-3xl font-semibold leading-none tabular-nums ${numColor}`}>{value}</span>
      <span className="text-xs text-zinc-600">{description}</span>
    </div>
  );
}
