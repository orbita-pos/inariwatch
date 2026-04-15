/**
 * Public status page for the InariWatch Replay platform.
 *
 * Live trust signal: how many sessions we've ingested in the last 24h,
 * how many distinct organizations are active, current pipeline health.
 * Cached aggressively (Redis, refreshed by a 5-min cron) so a status-page
 * scraping bot can't take down the DB.
 *
 * Public route: NO auth, served at https://app.inariwatch.com/status/replay
 * (in production via the inariwatch.com canonical). Buckets are coarse:
 * sessions floored to nearest 10, orgs to nearest 5, bytes to nearest 10 MB —
 * a scraper learns rough scale without precise per-day customer activity.
 */

import { getPublicStats, type ReplayPublicStats } from "@/lib/jobs/replay-stats";
import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Replay status — InariWatch",
  description: "Live operational status of the InariWatch session replay pipeline.",
  alternates: { canonical: "https://inariwatch.com/status/replay" },
  openGraph: {
    type: "website",
    url: "https://inariwatch.com/status/replay",
    siteName: "InariWatch",
    title: "Replay status — InariWatch",
    description: "Live operational status of the InariWatch session replay pipeline.",
  },
};

export default async function ReplayStatusPage() {
  let stats: ReplayPublicStats;
  try {
    stats = await getPublicStats();
  } catch {
    // Fail soft — public page must never 500.
    stats = {
      sessions24h: 0,
      activeOrgs24h: 0,
      bytes24h: 0,
      lastIngestAt: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Health classification — drives the colored dot at the top.
  // Green when we ingested < 5 min ago; amber 5-30 min; red beyond that.
  // Null lastIngest (genuine zero traffic) → amber, not red — could be
  // legitimate quiet hour for a small platform.
  const lastIngestMs = stats.lastIngestAt ? Date.parse(stats.lastIngestAt) : null;
  const minutesSinceIngest = lastIngestMs ? Math.round((Date.now() - lastIngestMs) / 60_000) : null;
  const health: "operational" | "degraded" | "outage" =
    minutesSinceIngest === null
      ? "degraded"
      : minutesSinceIngest < 5
        ? "operational"
        : minutesSinceIngest < 30
          ? "degraded"
          : "outage";

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <Link
        href="/"
        className="text-xs uppercase tracking-wider text-fg-base/50 hover:text-fg-base"
      >
        ← Inariwatch
      </Link>

      <div className="mt-8">
        <h1 className="text-3xl font-semibold text-fg-strong tracking-tight">Replay status</h1>
        <p className="mt-2 text-sm text-fg-base">
          Live operational metrics for the session replay pipeline.
        </p>
      </div>

      {/* Health banner — the single signal a customer would screenshot */}
      <div
        className={`mt-8 flex items-center gap-3 rounded-xl border px-5 py-4 ${
          health === "operational"
            ? "border-emerald-500/30 bg-emerald-500/5"
            : health === "degraded"
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-red-500/30 bg-red-500/5"
        }`}
      >
        <span
          className={`relative flex h-3 w-3 ${
            health === "operational" ? "" : "shrink-0"
          }`}
          aria-hidden="true"
        >
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${
              health === "operational"
                ? "bg-emerald-400"
                : health === "degraded"
                  ? "bg-amber-400"
                  : "bg-red-400"
            }`}
          />
          <span
            className={`relative inline-flex h-3 w-3 rounded-full ${
              health === "operational"
                ? "bg-emerald-500"
                : health === "degraded"
                  ? "bg-amber-500"
                  : "bg-red-500"
            }`}
          />
        </span>
        <div>
          <p className="text-sm font-semibold text-fg-strong">
            {health === "operational"
              ? "All systems operational"
              : health === "degraded"
                ? "Quiet — no recent ingest"
                : "Ingest delay detected"}
          </p>
          <p className="mt-0.5 text-xs text-fg-base/70">
            {minutesSinceIngest === null
              ? "No sessions ingested in the last 24h yet."
              : minutesSinceIngest === 0
                ? "Last session ingested just now."
                : `Last session ingested ${minutesSinceIngest} minute${minutesSinceIngest !== 1 ? "s" : ""} ago.`}
          </p>
        </div>
      </div>

      {/* 24h stats — the trust signals that matter to enterprise */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Sessions (24h)"
          value={formatCount(stats.sessions24h)}
          hint="Replay sessions ingested in the last 24 hours, rounded."
        />
        <Stat
          label="Active workspaces"
          value={stats.activeOrgs24h === 0 && (stats.lastIngestAt !== null) ? "<5" : formatCount(stats.activeOrgs24h)}
          hint="Distinct workspaces shipping replays in the last 24 hours."
        />
        <Stat
          label="Data processed"
          value={stats.bytes24h === 0 && (stats.lastIngestAt !== null) ? "<10 MB" : formatBytes(stats.bytes24h)}
          hint="Compressed replay data ingested in the last 24 hours."
        />
      </div>

      {/* Methodology footer — sets expectations + protects against the
          inevitable "but the numbers seem low!" question */}
      <div className="mt-10 rounded-lg border border-line bg-surface/50 px-5 py-4 text-xs leading-relaxed text-fg-base/70">
        <p className="font-medium text-fg-base">How we count</p>
        <p className="mt-1.5">
          Numbers reflect aggregate platform activity over the last 24 hours, refreshed
          every 5 minutes. Sessions are floored to the nearest 10, organizations to the
          nearest 5, and bytes to the nearest 10 MB — coarse enough to protect customer
          privacy while still showing real scale. We deliberately never publish
          per-organization figures.
        </p>
        <p className="mt-2">
          Snapshot generated{" "}
          <time dateTime={stats.generatedAt}>{formatRelative(stats.generatedAt)}</time>.
          For deeper SLAs, see the{" "}
          <Link href="/trust" className="text-inari-accent hover:underline">trust page</Link>.
        </p>
      </div>
    </div>
  );
}

// ── Presentational ──────────────────────────────────────────────────────

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3.5">
      <p className="text-[10px] uppercase tracking-wider text-fg-base/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-fg-strong">{value}</p>
      <p className="mt-1 text-[10px] leading-snug text-fg-base/40">{hint}</p>
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minute${seconds < 120 ? "" : "s"} ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hour${seconds < 7200 ? "" : "s"} ago`;
  return `${Math.floor(seconds / 86_400)} day${seconds < 172_800 ? "" : "s"} ago`;
}
