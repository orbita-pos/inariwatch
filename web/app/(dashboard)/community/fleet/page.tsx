import { db, errorPatterns, communityFixes } from "@/lib/db";
import { sql, desc, eq } from "drizzle-orm";
import { Activity, TrendingUp, Hash, Zap } from "lucide-react";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Fleet Stats" };

const CAT_COLORS: Record<string, string> = {
  runtime_error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  build_error:   "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  ci_error:      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  infrastructure:"bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  unknown:       "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function rateColor(rate: number) {
  if (rate >= 70) return "text-emerald-500";
  if (rate >= 40) return "text-amber-400";
  return "text-zinc-400";
}

export default async function FleetPage() {
  // Overview
  const [patternsCount] = await db.select({ count: sql<number>`count(*)` }).from(errorPatterns);
  const [fixesCount] = await db.select({ count: sql<number>`count(*)` }).from(communityFixes);
  const [appsRow] = await db.select({
    total: sql<number>`coalesce(sum(${communityFixes.totalApplications}), 0)`,
    success: sql<number>`coalesce(sum(${communityFixes.successCount}), 0)`,
    avgConf: sql<number>`coalesce(avg(${communityFixes.avgConfidence}), 0)`,
  }).from(communityFixes);

  const totalApps = Number(appsRow?.total ?? 0);
  const totalSuccess = Number(appsRow?.success ?? 0);
  const overallRate = totalApps > 0 ? Math.round((totalSuccess / totalApps) * 100) : 0;
  const avgConf = Math.round(Number(appsRow?.avgConf ?? 0));

  // Top successful (min 3 applications)
  const topSuccessful = await db.execute(sql`
    SELECT
      ep.pattern_text, ep.category, ep.occurrence_count,
      cf.fix_approach, cf.success_count, cf.total_applications,
      CASE WHEN cf.total_applications > 0
        THEN ROUND(cf.success_count * 100.0 / cf.total_applications)
        ELSE 0 END AS success_rate
    FROM community_fixes cf
    JOIN error_patterns ep ON ep.id = cf.pattern_id
    WHERE cf.total_applications >= 3
    ORDER BY success_rate DESC, cf.total_applications DESC
    LIMIT 10
  `);

  // Most attempted
  const mostAttempted = await db.execute(sql`
    SELECT
      ep.pattern_text, ep.category, ep.occurrence_count,
      (SELECT COUNT(*) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS fix_count,
      (SELECT COALESCE(SUM(cf.total_applications), 0) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS total_apps
    FROM error_patterns ep
    ORDER BY ep.occurrence_count DESC
    LIMIT 10
  `);

  // Recent activity
  const recentActivity = await db.execute(sql`
    SELECT
      cf.fix_approach, cf.updated_at, cf.success_count, cf.total_applications,
      ep.pattern_text, ep.category
    FROM community_fixes cf
    JOIN error_patterns ep ON ep.id = cf.pattern_id
    ORDER BY cf.updated_at DESC
    LIMIT 15
  `);

  const topRows = (topSuccessful.rows ?? []) as Record<string, unknown>[];
  const attemptedRows = (mostAttempted.rows ?? []) as Record<string, unknown>[];
  const activityRows = (recentActivity.rows ?? []) as Record<string, unknown>[];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-fg-strong">Fleet Stats</h1>
        <p className="text-sm text-fg-muted mt-1">
          Aggregate telemetry from all community fix patterns. Every fix teaches the system.
        </p>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard icon={<Hash className="h-4 w-4" />} label="Patterns" value={patternsCount.count} />
        <StatCard icon={<Zap className="h-4 w-4" />} label="Fixes Applied" value={totalApps} />
        <StatCard icon={<TrendingUp className="h-4 w-4" />} label="Success Rate" value={`${overallRate}%`} accent={overallRate >= 70} />
        <StatCard icon={<Activity className="h-4 w-4" />} label="Avg Confidence" value={`${avgConf}%`} />
      </div>

      {/* Top Successful */}
      <section>
        <h2 className="text-sm font-semibold text-fg-strong mb-3">Top Successful Patterns</h2>
        {topRows.length === 0 ? (
          <p className="text-sm text-fg-muted">No patterns with 3+ applications yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-dim">
                  <th className="text-left px-3 py-2 text-fg-muted font-medium">Pattern</th>
                  <th className="text-left px-3 py-2 text-fg-muted font-medium">Category</th>
                  <th className="text-right px-3 py-2 text-fg-muted font-medium">Applied</th>
                  <th className="text-right px-3 py-2 text-fg-muted font-medium">Success</th>
                </tr>
              </thead>
              <tbody>
                {topRows.map((r, i) => {
                  const rate = Number(r.success_rate ?? 0);
                  return (
                    <tr key={i} className="border-b border-line-subtle last:border-0">
                      <td className="px-3 py-2 text-fg-base max-w-xs truncate">{String(r.pattern_text ?? "").slice(0, 80)}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${CAT_COLORS[String(r.category)] ?? CAT_COLORS.unknown}`}>
                          {String(r.category)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-fg-muted tabular-nums">{String(r.total_applications)}</td>
                      <td className={`px-3 py-2 text-right font-medium tabular-nums ${rateColor(rate)}`}>{rate}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Most Attempted */}
      <section>
        <h2 className="text-sm font-semibold text-fg-strong mb-3">Most Attempted Patterns</h2>
        {attemptedRows.length === 0 ? (
          <p className="text-sm text-fg-muted">No patterns yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-dim">
                  <th className="text-left px-3 py-2 text-fg-muted font-medium">Pattern</th>
                  <th className="text-left px-3 py-2 text-fg-muted font-medium">Category</th>
                  <th className="text-right px-3 py-2 text-fg-muted font-medium">Occurrences</th>
                  <th className="text-right px-3 py-2 text-fg-muted font-medium">Fixes</th>
                </tr>
              </thead>
              <tbody>
                {attemptedRows.map((r, i) => (
                  <tr key={i} className="border-b border-line-subtle last:border-0">
                    <td className="px-3 py-2 text-fg-base max-w-xs truncate">{String(r.pattern_text ?? "").slice(0, 80)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${CAT_COLORS[String(r.category)] ?? CAT_COLORS.unknown}`}>
                        {String(r.category)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-fg-muted tabular-nums">{String(r.occurrence_count)}</td>
                    <td className="px-3 py-2 text-right text-fg-muted tabular-nums">{String(r.fix_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent Activity */}
      <section>
        <h2 className="text-sm font-semibold text-fg-strong mb-3">Recent Activity</h2>
        {activityRows.length === 0 ? (
          <p className="text-sm text-fg-muted">No fix contributions yet.</p>
        ) : (
          <div className="space-y-2">
            {activityRows.map((r, i) => {
              const apps = Number(r.total_applications ?? 0);
              const succ = Number(r.success_count ?? 0);
              const rate = apps > 0 ? Math.round((succ / apps) * 100) : 0;
              const ts = r.updated_at ? new Date(String(r.updated_at)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
              return (
                <div key={i} className="flex items-start gap-3 rounded-lg border border-line-subtle p-3 bg-surface">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium shrink-0 mt-0.5 ${CAT_COLORS[String(r.category)] ?? CAT_COLORS.unknown}`}>
                    {String(r.category)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg-base truncate">{String(r.fix_approach ?? "").slice(0, 100)}</p>
                    <p className="text-xs text-fg-muted truncate mt-0.5">{String(r.pattern_text ?? "").slice(0, 80)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-medium tabular-nums ${rateColor(rate)}`}>{rate}%</p>
                    <p className="text-xs text-fg-muted">{ts}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: number | string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-fg-muted mb-2">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <p className={`text-2xl font-bold tabular-nums ${accent ? "text-emerald-500" : "text-fg-strong"}`}>
        {value}
      </p>
    </div>
  );
}
