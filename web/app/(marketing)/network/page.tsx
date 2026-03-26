import Link from "next/link";
import { ArrowRight, Activity, TrendingUp, CheckCircle2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import { db, errorPatterns, communityFixes } from "@/lib/db";
import { eq, desc, sql, gt } from "drizzle-orm";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Network — InariWatch",
  description: "The InariWatch Network: collective software intelligence. Every fix makes every project stronger.",
};

export const revalidate = 300; // refresh every 5 min

async function getNetworkStats() {
  const [patternCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(errorPatterns);

  const [fixStats] = await db
    .select({
      totalFixes: sql<number>`count(*)`,
      totalApplications: sql<number>`coalesce(sum(${communityFixes.totalApplications}), 0)`,
      totalSuccess: sql<number>`coalesce(sum(${communityFixes.successCount}), 0)`,
      avgConfidence: sql<number>`coalesce(avg(${communityFixes.avgConfidence}), 0)`,
    })
    .from(communityFixes);

  const successRate = fixStats.totalApplications > 0
    ? Math.round((fixStats.totalSuccess / fixStats.totalApplications) * 100)
    : 0;

  const topPatterns = await db
    .select({
      patternText: errorPatterns.patternText,
      category: errorPatterns.category,
      occurrenceCount: errorPatterns.occurrenceCount,
      fixApproach: communityFixes.fixApproach,
      successCount: communityFixes.successCount,
      totalApplications: communityFixes.totalApplications,
    })
    .from(communityFixes)
    .innerJoin(errorPatterns, eq(communityFixes.patternId, errorPatterns.id))
    .where(gt(communityFixes.totalApplications, 0))
    .orderBy(desc(communityFixes.successCount))
    .limit(10);

  const recentActivity = await db
    .select({
      patternText: errorPatterns.patternText,
      category: errorPatterns.category,
      fixApproach: communityFixes.fixApproach,
      successRate: sql<number>`case when ${communityFixes.totalApplications} > 0 then round(${communityFixes.successCount}::numeric / ${communityFixes.totalApplications} * 100) else 0 end`,
      updatedAt: communityFixes.updatedAt,
    })
    .from(communityFixes)
    .innerJoin(errorPatterns, eq(communityFixes.patternId, errorPatterns.id))
    .orderBy(desc(communityFixes.updatedAt))
    .limit(15);

  return {
    totalPatterns: patternCount.count,
    totalFixes: fixStats.totalFixes,
    totalApplications: fixStats.totalApplications,
    successRate,
    avgConfidence: Math.round(fixStats.avgConfidence),
    topPatterns,
    recentActivity,
  };
}

function formatTimeAgo(date: Date | null): string {
  if (!date) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const CATEGORY_COLORS: Record<string, string> = {
  runtime_error: "text-red-400 bg-red-500/10 border-red-500/20",
  build_error: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  ci_error: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  infrastructure: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  unknown: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
};

export default async function NetworkPage() {
  const stats = await getNetworkStats();

  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />

      {/* Hero */}
      <section className="relative pt-32 pb-16 sm:pt-40 sm:pb-20">
        <div className="absolute inset-0 bg-radial-fade opacity-30" />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-4 py-1.5">
            <Activity className="h-3.5 w-3.5 text-inari-accent" />
            <span className="text-xs font-mono text-inari-accent tracking-wide">LIVE NETWORK</span>
          </div>

          <h1 className="text-4xl font-bold tracking-tight text-fg-strong sm:text-6xl leading-[1.05]">
            Every fix makes every
            <br />
            <span className="text-gradient-accent glow-accent-text">project stronger.</span>
          </h1>

          <p className="mt-6 text-lg text-fg-base max-w-2xl mx-auto leading-relaxed">
            When InariWatch fixes an error, the pattern is shared across the network.
            The next project with the same error gets an instant fix — because someone already solved it.
          </p>
        </div>
      </section>

      {/* Stats bar */}
      <div className="border-y border-inari-border bg-inari-card/40">
        <div className="mx-auto max-w-4xl px-6 py-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { value: stats.totalPatterns.toString(), label: "error patterns" },
              { value: stats.totalApplications.toString(), label: "fixes applied" },
              { value: `${stats.successRate}%`, label: "success rate" },
              { value: `${stats.avgConfidence}%`, label: "avg confidence" },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-2xl font-bold text-fg-strong font-mono">{s.value}</p>
                <p className="text-xs text-zinc-500 uppercase tracking-wider mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top patterns */}
      <section className="py-16">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex items-center gap-3 mb-8">
            <TrendingUp className="h-5 w-5 text-inari-accent" />
            <h2 className="text-xl font-bold text-fg-strong">Top Fix Patterns</h2>
          </div>

          {stats.topPatterns.length === 0 ? (
            <div className="rounded-xl border border-inari-border bg-inari-card p-8 text-center">
              <p className="text-zinc-500">No patterns yet. Be the first to contribute.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {stats.topPatterns.map((p, i) => {
                const successRate = p.totalApplications > 0
                  ? Math.round((p.successCount / p.totalApplications) * 100)
                  : 0;
                const colorClass = CATEGORY_COLORS[p.category] ?? CATEGORY_COLORS.unknown;

                return (
                  <div
                    key={i}
                    className="rounded-xl border border-inari-border bg-inari-card p-4 hover:border-inari-accent/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-fg-strong truncate">{p.patternText}</p>
                        <p className="text-xs text-zinc-500 mt-1 truncate">{p.fixApproach}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className={`text-xs font-mono px-2 py-0.5 rounded-full border ${colorClass}`}>
                          {p.category.replace("_", " ")}
                        </span>
                        <span className="text-xs text-zinc-500 font-mono">{p.totalApplications} applied</span>
                        <span className="text-xs font-mono text-green-400">{successRate}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Recent activity */}
      <section className="py-16 border-t border-inari-border">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex items-center gap-3 mb-8">
            <Zap className="h-5 w-5 text-inari-accent" />
            <h2 className="text-xl font-bold text-fg-strong">Recent Activity</h2>
          </div>

          {stats.recentActivity.length === 0 ? (
            <div className="rounded-xl border border-inari-border bg-inari-card p-8 text-center">
              <p className="text-zinc-500">No activity yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {stats.recentActivity.map((a, i) => {
                const colorClass = CATEGORY_COLORS[a.category] ?? CATEGORY_COLORS.unknown;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-4 rounded-lg border border-inari-border bg-inari-card px-4 py-3"
                  >
                    <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-fg-base truncate">{a.patternText}</p>
                    </div>
                    <span className={`text-xs font-mono px-2 py-0.5 rounded-full border ${colorClass} shrink-0`}>
                      {a.category.replace("_", " ")}
                    </span>
                    <span className="text-xs text-green-400 font-mono shrink-0">{a.successRate}%</span>
                    <span className="text-xs text-zinc-600 shrink-0">{formatTimeAgo(a.updatedAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 border-t border-inari-border">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="text-2xl font-bold text-fg-strong sm:text-3xl">
            Your fixes strengthen the network.
          </h2>
          <p className="mt-4 text-fg-base max-w-lg mx-auto">
            Connect your project. Every error you fix becomes a pattern that helps
            the next developer with the same problem.
          </p>
          <div className="mt-8">
            <Link href="/register">
              <Button variant="primary" className="px-8 py-3">
                Join the network
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-inari-border py-10">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="font-mono text-fg-base uppercase tracking-widest text-xs font-semibold">INARIWATCH</span>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <Link href="/" className="hover:text-fg-base transition-colors">Home</Link>
            <Link href="/docs" className="hover:text-fg-base transition-colors">Docs</Link>
            <Link href="/trust" className="hover:text-fg-base transition-colors">Trust</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
