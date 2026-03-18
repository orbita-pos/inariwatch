import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, projectIntegrations, users, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { eq, desc, inArray, and, ilike, arrayOverlaps, type SQL } from "drizzle-orm";
import { formatRelativeTime } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import { AlertsFilters } from "./alerts-filters";
import { ExportButton } from "./export-button";
import { LiveIndicator } from "./live-indicator";

export const metadata: Metadata = { title: "Alerts" };

// ── Severity tokens ───────────────────────────────────────────────────────────

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
const SEV_BAR: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-400",
  info:     "bg-blue-400",
};


// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const severityFilter = (Array.isArray(params.severity) ? params.severity[0] : params.severity) ?? "all";
  const statusFilter   = (Array.isArray(params.status)   ? params.status[0]   : params.status)   ?? "all";
  const sourceFilter   = (Array.isArray(params.source)   ? params.source[0]   : params.source)   ?? "all";
  const searchQuery    = (Array.isArray(params.q)        ? params.q[0]        : params.q)        ?? "";

  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const [userRow] = userId
    ? await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId))
    : [undefined];
  const isPro = userRow?.plan === "pro";

  const projectIds = userId ? await getWorkspaceProjectIds(userId, await getActiveOrgId()) : [];

  const conditions: SQL[] = [];
  if (projectIds.length > 0) conditions.push(inArray(alerts.projectId, projectIds));
  if (severityFilter !== "all" && ["critical", "warning", "info"].includes(severityFilter)) {
    conditions.push(eq(alerts.severity, severityFilter as "critical" | "warning" | "info"));
  }
  if (statusFilter === "open")     conditions.push(eq(alerts.isResolved, false));
  if (statusFilter === "resolved") conditions.push(eq(alerts.isResolved, true));
  if (sourceFilter !== "all" && ["github", "vercel", "sentry", "uptime", "postgres", "npm"].includes(sourceFilter)) {
    conditions.push(arrayOverlaps(alerts.sourceIntegrations, [sourceFilter]));
  }
  if (searchQuery.trim()) conditions.push(ilike(alerts.title, `%${searchQuery.trim()}%`));

  const [allAlerts, integrationRows] =
    projectIds.length > 0
      ? await Promise.all([
          db.select().from(alerts).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(desc(alerts.createdAt)).limit(50),
          db.select({ id: projectIntegrations.id }).from(projectIntegrations).where(inArray(projectIntegrations.projectId, projectIds)).limit(1),
        ])
      : [[], []];

  const hasIntegrations    = integrationRows.length > 0;
  const unread             = allAlerts.filter((a) => !a.isRead).length;
  const critical           = allAlerts.filter((a) => a.severity === "critical").length;
  const open               = allAlerts.filter((a) => !a.isResolved).length;
  const hasActiveFilters   = severityFilter !== "all" || statusFilter !== "all" || sourceFilter !== "all" || searchQuery.trim() !== "";

  return (
    <div className="space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Alerts</h1>
            <LiveIndicator />
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {allAlerts.length} alert{allAlerts.length !== 1 ? "s" : ""}{hasActiveFilters ? " (filtered)" : ""}
          </p>
        </div>

        {allAlerts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Chip dot="bg-amber-400" label={`${unread} unread`} />
            <Chip dot="bg-inari-accent" label={`${critical} critical`} />
            <Chip dot="bg-green-500" label={`${open} open`} />
            {isPro && <ExportButton />}
          </div>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <AlertsFilters severity={severityFilter} status={statusFilter} source={sourceFilter} />

      {/* ── List ───────────────────────────────────────────────────────── */}
      {allAlerts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-16 text-center">
          <CheckCircle2 className="h-5 w-5 text-zinc-700" />
          <p className="text-sm font-medium text-zinc-500">
            {hasActiveFilters ? "No alerts match your filters" : "No alerts yet"}
          </p>
          <p className="text-sm text-zinc-600">
            {hasActiveFilters ? (
              <Link href="/alerts" className="text-zinc-400 underline underline-offset-2 transition-colors hover:text-fg-strong">
                Clear all filters
              </Link>
            ) : hasIntegrations ? (
              "InariWatch is watching your integrations."
            ) : (
              <>
                <Link href="/integrations" className="text-zinc-400 underline underline-offset-2 transition-colors hover:text-fg-strong">
                  Connect an integration
                </Link>{" "}
                to start receiving alerts.
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {allAlerts.map((alert) => (
            <Link
              key={alert.id}
              href={`/alerts/${alert.id}`}
              className="group relative flex items-center gap-4 border-b border-line-subtle bg-surface px-4 py-3.5 transition-colors last:border-0 hover:bg-black/[0.025] dark:hover:bg-white/[0.025]"
            >
              {/* Severity bar */}
              <span className={`absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full opacity-60 ${SEV_BAR[alert.severity] ?? "bg-zinc-700"}`} />

              {/* Dot */}
              <span className={`ml-1 h-2 w-2 shrink-0 rounded-full ${SEV_DOT[alert.severity] ?? "bg-zinc-600"}`} />

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {!alert.isRead && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                  )}
                  <p className="truncate text-sm font-medium text-fg-base transition-colors group-hover:text-fg-strong">
                    {alert.title}
                  </p>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-600">
                  <span className={`font-medium ${SEV_TEXT[alert.severity] ?? "text-zinc-500"}`}>
                    {alert.severity}
                  </span>
                  {alert.body && (
                    <>
                      <span>·</span>
                      <span className="truncate">{alert.body}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Source badges */}
              <div className="hidden shrink-0 items-center gap-1 md:flex">
                {alert.sourceIntegrations.slice(0, 2).map((src) => (
                  <span key={src} className="rounded border border-line-medium bg-surface-dim px-1.5 py-0.5 font-mono text-xs text-zinc-600">
                    {src}
                  </span>
                ))}
              </div>

              {/* Time + status */}
              <div className="shrink-0 text-right">
                <p className="font-mono text-xs text-zinc-600 transition-colors group-hover:text-zinc-500">
                  {formatRelativeTime(alert.createdAt)}
                </p>
                <p className={`text-xs ${alert.isResolved ? "text-zinc-700" : "text-amber-500/80"}`}>
                  {alert.isResolved ? "resolved" : "open"}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Chip({ dot, label }: { dot: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-xs tabular-nums text-zinc-400">{label}</span>
    </div>
  );
}
