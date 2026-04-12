import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Activity, TrendingUp, CheckCircle2, Zap, Shield, Code2, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "../marketing-nav";
import { db, errorPatterns, communityFixes, fixRatings } from "@/lib/db";
import { eq, desc, sql, gt } from "drizzle-orm";
import type { Metadata } from "next";

const PAGE_TITLE       = "Network — InariWatch";
const PAGE_DESCRIPTION = "The InariWatch Network: collective software intelligence. Every fix makes every project stronger. Crowdsourced fixes, anonymized contributions, public APIs.";
const PAGE_URL         = "https://inariwatch.com/network";

export const metadata: Metadata = {
  title:       PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates:  { canonical: PAGE_URL },
  openGraph: {
    type:        "website",
    url:         PAGE_URL,
    siteName:    "InariWatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    // images auto-resolved from app/opengraph-image.tsx
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

export const revalidate = 300; // refresh every 5 min

async function getNetworkStats() {
  const [patternCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(errorPatterns);

  const [fixStats] = await db
    .select({
      totalFixes:        sql<number>`count(*)`,
      totalApplications: sql<number>`coalesce(sum(${communityFixes.totalApplications}), 0)`,
      totalSuccess:      sql<number>`coalesce(sum(${communityFixes.successCount}), 0)`,
      totalFailures:     sql<number>`coalesce(sum(${communityFixes.failureCount}), 0)`,
      avgConfidence:     sql<number>`coalesce(avg(${communityFixes.avgConfidence}), 0)`,
    })
    .from(communityFixes);

  const successRate = fixStats.totalApplications > 0
    ? Math.round((fixStats.totalSuccess / fixStats.totalApplications) * 100)
    : 0;

  const [ratingStats] = await db
    .select({ count: sql<number>`count(*)` })
    .from(fixRatings);

  const topPatterns = await db
    .select({
      patternText:       errorPatterns.patternText,
      category:          errorPatterns.category,
      occurrenceCount:   errorPatterns.occurrenceCount,
      fixApproach:       communityFixes.fixApproach,
      successCount:      communityFixes.successCount,
      failureCount:      communityFixes.failureCount,
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
      category:    errorPatterns.category,
      fixApproach: communityFixes.fixApproach,
      successRate: sql<number>`case when ${communityFixes.totalApplications} > 0 then round(${communityFixes.successCount}::numeric / ${communityFixes.totalApplications} * 100) else 0 end`,
      updatedAt:   communityFixes.updatedAt,
    })
    .from(communityFixes)
    .innerJoin(errorPatterns, eq(communityFixes.patternId, errorPatterns.id))
    .orderBy(desc(communityFixes.updatedAt))
    .limit(15);

  // Count distinct patterns with multiple fix approaches
  const [multiFixCount] = await db
    .select({ count: sql<number>`count(distinct ${communityFixes.patternId})` })
    .from(communityFixes);

  return {
    totalPatterns:              patternCount.count,
    totalFixes:                 fixStats.totalFixes,
    totalApplications:          fixStats.totalApplications,
    totalFailures:              fixStats.totalFailures,
    successRate,
    avgConfidence:              Math.round(fixStats.avgConfidence),
    totalRatings:               ratingStats.count,
    patternsWithMultipleFixes:  multiFixCount.count,
    topPatterns,
    recentActivity,
  };
}

function formatTimeAgo(date: Date | null): string {
  if (!date) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60)    return "just now";
  if (seconds < 3600)  return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const CATEGORY_COLORS: Record<string, string> = {
  runtime_error:  "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/25",
  build_error:    "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25",
  ci_error:       "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/25",
  infrastructure: "text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/25",
  unknown:        "text-fg-base bg-inari-card border-inari-border",
};

export default async function NetworkPage() {
  const stats = await getNetworkStats();

  return (
    <div className="min-h-screen bg-inari-bg">
      <MarketingNav opaque />

      <main>

      {/* Hero */}
      <section className="relative pt-32 pb-16 sm:pt-40 sm:pb-20">
        <div className="absolute inset-0 bg-radial-fade opacity-30" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-inari-accent/30 bg-inari-accent/10 px-4 py-1.5">
            <Activity className="h-3.5 w-3.5 text-inari-accent" aria-hidden="true" />
            <span className="text-xs font-mono text-inari-accent tracking-wide">LIVE NETWORK</span>
          </div>

          <h1 className="text-4xl font-bold tracking-tight text-fg-strong sm:text-6xl leading-[1.05]">
            Every fix makes every
            <br />
            <span className="text-gradient-accent glow-accent-text">project stronger.</span>
          </h1>

          <p className="mt-6 text-lg text-fg-base max-w-2xl mx-auto leading-relaxed">
            When InariWatch fixes an error, the pattern is anonymized and shared across the network.
            The next project with the same error gets an instant fix — because someone already solved it.
          </p>
        </div>
      </section>

      {/* Stats bar */}
      <section aria-labelledby="stats-heading" className="border-y border-inari-border bg-inari-card/40">
        <h2 id="stats-heading" className="sr-only">Network statistics</h2>
        <div className="mx-auto max-w-5xl px-6 py-5">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              { value: stats.totalPatterns.toString(),    label: "error patterns" },
              { value: stats.totalFixes.toString(),       label: "fix approaches" },
              { value: stats.totalApplications.toString(),label: "fixes applied" },
              { value: `${stats.successRate}%`,           label: "success rate" },
              { value: stats.totalRatings.toString(),     label: "community ratings" },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <dt className="text-xs text-fg-base/70 uppercase tracking-wider mt-0.5 order-2">{s.label}</dt>
                <dd className="text-2xl font-bold text-fg-strong font-mono">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* How it works */}
      <section aria-labelledby="how-heading" className="py-16 border-b border-inari-border">
        <div className="mx-auto max-w-4xl px-6">
          <h2 id="how-heading" className="text-xl font-bold text-fg-strong mb-8 text-center">How the network works</h2>
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="rounded-xl border border-inari-border bg-inari-card p-5">
              <div className="h-8 w-8 rounded-lg bg-inari-accent/10 flex items-center justify-center mb-3">
                <Zap className="h-4 w-4 text-inari-accent" aria-hidden="true" />
              </div>
              <h3 className="text-sm font-semibold text-fg-strong">Auto-contribution</h3>
              <p className="text-xs text-fg-base mt-1.5 leading-relaxed">
                When a fix passes CI and gets approved, the pattern is automatically contributed to the network. No manual action needed.
              </p>
            </div>
            <div className="rounded-xl border border-inari-border bg-inari-card p-5">
              <div className="h-8 w-8 rounded-lg bg-inari-accent/10 flex items-center justify-center mb-3">
                <Shield className="h-4 w-4 text-inari-accent" aria-hidden="true" />
              </div>
              <h3 className="text-sm font-semibold text-fg-strong">Anonymized by default</h3>
              <p className="text-xs text-fg-base mt-1.5 leading-relaxed">
                Emails, auth tokens, IP addresses, URLs, and absolute system paths are stripped from all text before sharing. No contributor identity, no repo names, no file contents. Only the fix approach and error pattern.
              </p>
            </div>
            <div className="rounded-xl border border-inari-border bg-inari-card p-5">
              <div className="h-8 w-8 rounded-lg bg-inari-accent/10 flex items-center justify-center mb-3">
                <CheckCircle2 className="h-4 w-4 text-inari-accent" aria-hidden="true" />
              </div>
              <h3 className="text-sm font-semibold text-fg-strong">60% threshold</h3>
              <p className="text-xs text-fg-base mt-1.5 leading-relaxed">
                Fixes are only recommended to other projects if they have a 60%+ success rate. Low-quality fixes are tracked but never suggested.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Top patterns */}
      <section aria-labelledby="top-heading" className="py-16">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex items-center gap-3 mb-8">
            <TrendingUp className="h-5 w-5 text-inari-accent" aria-hidden="true" />
            <h2 id="top-heading" className="text-xl font-bold text-fg-strong">Top Fix Patterns</h2>
          </div>

          {stats.topPatterns.length === 0 ? (
            <div className="rounded-xl border border-inari-border bg-inari-card p-8 text-center">
              <p className="text-fg-base">No patterns yet. Be the first to contribute.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {stats.topPatterns.map((p, i) => {
                const successRate = p.totalApplications > 0
                  ? Math.round((p.successCount / p.totalApplications) * 100)
                  : 0;
                const colorClass = CATEGORY_COLORS[p.category] ?? CATEGORY_COLORS.unknown;

                return (
                  <li
                    key={i}
                    className="rounded-xl border border-inari-border bg-inari-card p-4 hover:border-inari-accent/40 hover:bg-surface-inner transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-fg-strong truncate">{p.patternText}</p>
                        <p className="text-xs text-fg-base/70 mt-1 truncate">{p.fixApproach}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className={`text-xs font-mono px-2 py-0.5 rounded-full border ${colorClass}`}>
                          {p.category.replace("_", " ")}
                        </span>
                        <span className="text-xs text-fg-base/70 font-mono">{p.totalApplications} applied</span>
                        <span className={`text-xs font-mono ${successRate >= 60 ? "text-emerald-600 dark:text-emerald-400" : "text-fg-base/60"}`}>
                          {successRate}%
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Recent activity */}
      <section aria-labelledby="recent-heading" className="py-16 border-t border-inari-border">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex items-center gap-3 mb-8">
            <Zap className="h-5 w-5 text-inari-accent" aria-hidden="true" />
            <h2 id="recent-heading" className="text-xl font-bold text-fg-strong">Recent Activity</h2>
          </div>

          {stats.recentActivity.length === 0 ? (
            <div className="rounded-xl border border-inari-border bg-inari-card p-8 text-center">
              <p className="text-fg-base">No activity yet.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {stats.recentActivity.map((a, i) => {
                const colorClass = CATEGORY_COLORS[a.category] ?? CATEGORY_COLORS.unknown;
                return (
                  <li
                    key={i}
                    className="flex items-center gap-4 rounded-lg border border-inari-border bg-inari-card px-4 py-3"
                  >
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-fg-base truncate">{a.patternText}</p>
                    </div>
                    <span className={`text-xs font-mono px-2 py-0.5 rounded-full border ${colorClass} shrink-0`}>
                      {a.category.replace("_", " ")}
                    </span>
                    <span className={`text-xs font-mono shrink-0 ${a.successRate >= 60 ? "text-emerald-600 dark:text-emerald-400" : "text-fg-base/60"}`}>
                      {a.successRate}%
                    </span>
                    <span className="text-xs text-fg-base/60 shrink-0">{formatTimeAgo(a.updatedAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* API access */}
      <section aria-labelledby="api-heading" className="py-16 border-t border-inari-border">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex items-center gap-3 mb-8">
            <Terminal className="h-5 w-5 text-inari-accent" aria-hidden="true" />
            <h2 id="api-heading" className="text-xl font-bold text-fg-strong">Programmatic Access</h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-inari-border bg-inari-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Code2 className="h-4 w-4 text-inari-accent" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-fg-strong">Public REST API</h3>
              </div>
              <div className="space-y-2 text-xs font-mono text-fg-base">
                <p><span className="text-emerald-600 dark:text-emerald-400">GET</span> /api/community/fixes</p>
                <p><span className="text-emerald-600 dark:text-emerald-400">GET</span> /api/community/fixes/:id</p>
                <p><span className="text-emerald-600 dark:text-emerald-400">GET</span> /api/patterns/search?q=...</p>
                <p><span className="text-emerald-600 dark:text-emerald-400">GET</span> /api/patterns/trending</p>
                <p><span className="text-amber-600 dark:text-amber-400">POST</span> /api/community/fixes/:id/report</p>
              </div>
              <p className="text-[11px] text-fg-base/70 mt-3">CORS-enabled. No auth required for reads.</p>
            </div>
            <div className="rounded-xl border border-inari-border bg-inari-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Activity className="h-4 w-4 text-inari-accent" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-fg-strong">MCP Tool</h3>
              </div>
              <p className="text-xs text-fg-base leading-relaxed">
                AI coding tools (Claude Code, Cursor, Windsurf) can search the network via the{" "}
                <span className="font-mono text-inari-accent">search_community_fixes</span> MCP tool.
                Connect at <span className="font-mono text-fg-strong">mcp.inariwatch.com</span>.
              </p>
              <p className="text-xs text-fg-base mt-3 leading-relaxed">
                When you view an alert in the dashboard, matching community fixes appear automatically
                with success rates and one-click apply.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 border-t border-inari-border">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="text-2xl font-bold text-fg-strong sm:text-3xl">
            Your fixes strengthen the network.
          </h2>
          <p className="mt-4 text-fg-base max-w-lg mx-auto">
            Connect your project. Every approved fix is automatically anonymized and contributed.
            Every error you fix becomes a pattern that helps the next developer with the same problem.
          </p>
          <div className="mt-8">
            <Link href="/register">
              <Button variant="primary" className="px-8 py-3">
                Join the network
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      </main>

      {/* Footer — matches landing page */}
      <footer className="border-t border-inari-border py-12">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <Image
                src="/logo-inari/favicon-96x96.png"
                alt=""
                width={24}
                height={24}
              />
              <span className="font-mono text-sm text-fg-base">
                inariwatch · built in MX
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fg-base">
              <Link href="/docs"    className="hover:text-fg-strong transition-colors">Docs</Link>
              <Link href="/pricing" className="hover:text-fg-strong transition-colors">Pricing</Link>
              <Link href="/download" className="hover:text-fg-strong transition-colors">Mobile</Link>
              <Link href="/trust"   className="hover:text-fg-strong transition-colors">Trust</Link>
              <Link href="/status"  className="hover:text-fg-strong transition-colors">Status</Link>
              <Link href="/blog"    className="hover:text-fg-strong transition-colors">Blog</Link>
              <a
                href="https://github.com/orbita-pos/inariwatch-capture"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-fg-strong transition-colors"
              >
                GitHub
              </a>
              <Link href="/privacy" className="hover:text-fg-strong transition-colors">Privacy</Link>
              <Link href="/terms"   className="hover:text-fg-strong transition-colors">Terms</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
