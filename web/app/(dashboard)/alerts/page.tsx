import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, projectIntegrations, getUserProjectIds } from "@/lib/db";
import { eq, desc, inArray, and, ilike, arrayOverlaps, type SQL } from "drizzle-orm";
import { formatRelativeTime } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import { SearchInput } from "./search-input";
import { ExportButton } from "./export-button";
import { LiveIndicator } from "./live-indicator";

export const metadata: Metadata = { title: "Alerts" };

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-400",
  info:     "bg-blue-400",
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "text-inari-accent",
  warning:  "text-amber-400",
  info:     "text-blue-400",
};

// ── Filter definitions ──────────────────────────────────────────────────────

type FilterOption = { label: string; value: string };

const SEVERITY_OPTIONS: FilterOption[] = [
  { label: "All",      value: "all" },
  { label: "Critical", value: "critical" },
  { label: "Warning",  value: "warning" },
  { label: "Info",     value: "info" },
];

const STATUS_OPTIONS: FilterOption[] = [
  { label: "All",      value: "all" },
  { label: "Open",     value: "open" },
  { label: "Resolved", value: "resolved" },
];

const SOURCE_OPTIONS: FilterOption[] = [
  { label: "All",      value: "all" },
  { label: "GitHub",   value: "github" },
  { label: "Vercel",   value: "vercel" },
  { label: "Sentry",   value: "sentry" },
  { label: "Uptime",   value: "uptime" },
  { label: "Postgres", value: "postgres" },
  { label: "npm",      value: "npm" },
];

// ── Helper to build a URL with updated search params ────────────────────────

function buildFilterUrl(
  current: Record<string, string | string[] | undefined>,
  key: string,
  value: string,
): string {
  const params = new URLSearchParams();
  // Carry forward existing params
  for (const [k, v] of Object.entries(current)) {
    if (k === key) continue;
    const val = Array.isArray(v) ? v[0] : v;
    if (val) params.set(k, val);
  }
  // Set (or remove) the new param
  if (value && value !== "all") {
    params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/alerts?${qs}` : "/alerts";
}

// ── Filter pill component (server rendered Link) ────────────────────────────

function FilterPill({
  option,
  isActive,
  href,
}: {
  option: FilterOption;
  isActive: boolean;
  href: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        isActive
          ? "bg-inari-accent/10 text-inari-accent border-inari-accent/30"
          : "bg-transparent text-zinc-500 border-inari-border hover:text-zinc-300"
      }`}
    >
      {option.label}
    </Link>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const severityFilter = (Array.isArray(params.severity) ? params.severity[0] : params.severity) ?? "all";
  const statusFilter   = (Array.isArray(params.status) ? params.status[0] : params.status) ?? "all";
  const sourceFilter   = (Array.isArray(params.source) ? params.source[0] : params.source) ?? "all";
  const searchQuery    = (Array.isArray(params.q) ? params.q[0] : params.q) ?? "";

  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const projectIds = userId ? await getUserProjectIds(userId) : [];

  // ── Build dynamic where conditions ──────────────────────────────────────
  const conditions: SQL[] = [];

  if (projectIds.length > 0) {
    conditions.push(inArray(alerts.projectId, projectIds));
  }

  if (severityFilter !== "all" && ["critical", "warning", "info"].includes(severityFilter)) {
    conditions.push(eq(alerts.severity, severityFilter as "critical" | "warning" | "info"));
  }

  if (statusFilter === "open") {
    conditions.push(eq(alerts.isResolved, false));
  } else if (statusFilter === "resolved") {
    conditions.push(eq(alerts.isResolved, true));
  }

  if (sourceFilter !== "all" && ["github", "vercel", "sentry", "uptime", "postgres", "npm"].includes(sourceFilter)) {
    conditions.push(arrayOverlaps(alerts.sourceIntegrations, [sourceFilter]));
  }

  if (searchQuery.trim()) {
    conditions.push(ilike(alerts.title, `%${searchQuery.trim()}%`));
  }

  const allAlerts =
    projectIds.length > 0
      ? await db
          .select()
          .from(alerts)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(alerts.createdAt))
          .limit(50)
      : [];

  const hasIntegrations =
    projectIds.length > 0
      ? (await db
          .select({ id: projectIntegrations.id })
          .from(projectIntegrations)
          .where(inArray(projectIntegrations.projectId, projectIds))
          .limit(1)
        ).length > 0
      : false;

  const unread   = allAlerts.filter((a) => !a.isRead).length;
  const critical = allAlerts.filter((a) => a.severity === "critical").length;
  const open     = allAlerts.filter((a) => !a.isResolved).length;

  const hasActiveFilters = severityFilter !== "all" || statusFilter !== "all" || sourceFilter !== "all" || searchQuery.trim() !== "";

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-white tracking-tight">Alerts</h1>
            <LiveIndicator />
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {allAlerts.length} total{hasActiveFilters ? " (filtered)" : ""}
          </p>
        </div>
        {allAlerts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-[#1a1a1a] bg-[#0a0a0a] px-3 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              <span className="text-xs tabular-nums text-zinc-400">{unread} unread</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border border-[#1a1a1a] bg-[#0a0a0a] px-3 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-inari-accent" />
              <span className="text-xs tabular-nums text-zinc-400">{critical} critical</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border border-[#1a1a1a] bg-[#0a0a0a] px-3 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              <span className="text-xs tabular-nums text-zinc-400">{open} open</span>
            </div>
            <ExportButton />
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-inari-border bg-inari-card p-4">
        {/* Search */}
        <SearchInput />

        {/* Filter groups */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-3">
          {/* Severity */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-zinc-500 uppercase tracking-wider">Severity</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {SEVERITY_OPTIONS.map((opt) => (
                <FilterPill
                  key={opt.value}
                  option={opt}
                  isActive={severityFilter === opt.value}
                  href={buildFilterUrl(params, "severity", opt.value)}
                />
              ))}
            </div>
          </div>

          {/* Status */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-zinc-500 uppercase tracking-wider">Status</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {STATUS_OPTIONS.map((opt) => (
                <FilterPill
                  key={opt.value}
                  option={opt}
                  isActive={statusFilter === opt.value}
                  href={buildFilterUrl(params, "status", opt.value)}
                />
              ))}
            </div>
          </div>

          {/* Source */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-zinc-500 uppercase tracking-wider">Source</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {SOURCE_OPTIONS.map((opt) => (
                <FilterPill
                  key={opt.value}
                  option={opt}
                  isActive={sourceFilter === opt.value}
                  href={buildFilterUrl(params, "source", opt.value)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Alert list */}
      {allAlerts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[#1a1a1a] py-16 text-center">
          <CheckCircle2 className="h-5 w-5 text-zinc-700" />
          <p className="text-sm font-medium text-zinc-500">
            {hasActiveFilters ? "No alerts match your filters" : "No alerts yet"}
          </p>
          <p className="text-sm text-zinc-600">
            {hasActiveFilters ? (
              <Link
                href="/alerts"
                className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
              >
                Clear all filters
              </Link>
            ) : hasIntegrations ? (
              "InariWatch is watching your integrations. Alerts will appear here when something needs attention."
            ) : (
              <>
                <Link
                  href="/integrations"
                  className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
                >
                  Connect an integration
                </Link>{" "}
                to start receiving alerts.
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-[#1a1a1a] overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[16px_1fr_auto] md:grid-cols-[24px_1fr_auto_auto] items-center gap-2 md:gap-3 border-b border-[#1a1a1a] bg-[#111] px-3 md:px-5 py-2.5">
            <span />
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Alert</span>
            <span className="hidden text-xs font-medium text-zinc-500 uppercase tracking-wider md:block">Source</span>
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">When</span>
          </div>

          {/* Rows */}
          <div className="divide-y divide-[#131313] bg-[#0a0a0a]">
            {allAlerts.map((alert) => (
              <Link
                key={alert.id}
                href={`/alerts/${alert.id}`}
                className="group grid grid-cols-[16px_1fr_auto] md:grid-cols-[24px_1fr_auto_auto] items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 hover:bg-white/[0.025] transition-colors"
              >
                {/* Status dot */}
                <div className="flex items-center justify-center">
                  <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[alert.severity] ?? "bg-zinc-700"}`} />
                </div>

                {/* Title */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {!alert.isRead && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                    )}
                    <p className="truncate text-sm text-zinc-200 group-hover:text-white transition-colors">
                      {alert.title}
                    </p>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className={`text-xs font-medium ${SEVERITY_LABEL[alert.severity] ?? "text-zinc-600"}`}>
                      {alert.severity}
                    </span>
                    {alert.body && (
                      <>
                        <span className="text-zinc-800">&middot;</span>
                        <span className="truncate text-xs text-zinc-500">{alert.body}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Source */}
                <div className="hidden items-center gap-1 md:flex">
                  {alert.sourceIntegrations.slice(0, 2).map((src) => (
                    <span key={src} className="rounded border border-[#222] bg-[#111] px-1.5 py-0.5 font-mono text-xs text-zinc-500">
                      {src}
                    </span>
                  ))}
                </div>

                {/* Time + status */}
                <div className="text-right">
                  <p className="font-mono text-xs text-zinc-500">
                    {formatRelativeTime(alert.createdAt)}
                  </p>
                  <p className={`text-xs ${alert.isResolved ? "text-zinc-600" : "text-amber-500"}`}>
                    {alert.isResolved ? "resolved" : "open"}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
