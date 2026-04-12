import {
  db, alerts, statusPages, projects, projectIntegrations,
  uptimeMonitors, uptimeChecks, statusPageIncidents, statusPageUpdates,
} from "@/lib/db";
import { eq, and, desc, inArray, gte, ne } from "drizzle-orm";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [page] = await db
    .select()
    .from(statusPages)
    .where(eq(statusPages.slug, slug))
    .limit(1);

  if (!page) return { title: "Status — InariWatch" };

  const title       = `${page.title} — Status`;
  const description = `Real-time operational status and incident history for ${page.title}. Powered by InariWatch.`;
  const url         = `https://inariwatch.com/status/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type:        "website",
      url,
      siteName:    "InariWatch",
      title,
      description,
    },
    twitter: {
      card:        "summary_large_image",
      site:        "@inariwatch",
      title,
      description,
    },
  };
}

// ── Status config ─────────────────────────────────────────────────────────────

const INCIDENT_STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  investigating: { label: "Investigating",   color: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  identified:    { label: "Identified",      color: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  fixing:        { label: "Fix in Progress", color: "text-blue-600 dark:text-blue-400",   dot: "bg-blue-500"  },
  monitoring:    { label: "Monitoring",      color: "text-blue-600 dark:text-blue-400",   dot: "bg-blue-500"  },
  resolved:      { label: "Resolved",        color: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  regressed:     { label: "Regressed",       color: "text-red-600 dark:text-red-400",     dot: "bg-red-500"   },
};

export default async function PublicStatusPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const [page] = await db
    .select()
    .from(statusPages)
    .where(and(eq(statusPages.slug, slug), eq(statusPages.isPublic, true)))
    .limit(1);

  if (!page) notFound();

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, page.projectId))
    .limit(1);

  if (!project) notFound();

  // Get integrations for this project
  const integrations = await db
    .select({ id: projectIntegrations.id, service: projectIntegrations.service, lastCheckedAt: projectIntegrations.lastCheckedAt, isActive: projectIntegrations.isActive })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.projectId, project.id));

  // Get recent alerts (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, project.id),
        gte(alerts.createdAt, sevenDaysAgo)
      )
    )
    .orderBy(desc(alerts.createdAt))
    .limit(20);

  // Get uptime monitors for this project
  const monitors = await db
    .select()
    .from(uptimeMonitors)
    .where(and(eq(uptimeMonitors.projectId, project.id), eq(uptimeMonitors.isActive, true)));

  // Get 90 days of checks per monitor (for uptime %)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const allChecks = monitors.length > 0
    ? await db
      .select({ monitorId: uptimeChecks.monitorId, isUp: uptimeChecks.isUp, checkedAt: uptimeChecks.checkedAt })
      .from(uptimeChecks)
      .where(and(
        inArray(uptimeChecks.monitorId, monitors.map(m => m.id)),
        gte(uptimeChecks.checkedAt, ninetyDaysAgo)
      ))
    : [];

  // Get status page incidents (active + recently resolved)
  const activeIncidents = await db
    .select()
    .from(statusPageIncidents)
    .where(
      and(
        eq(statusPageIncidents.statusPageId, page.id),
        ne(statusPageIncidents.status, "resolved"),
      )
    )
    .orderBy(desc(statusPageIncidents.createdAt))
    .limit(10);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const resolvedIncidents = await db
    .select()
    .from(statusPageIncidents)
    .where(
      and(
        eq(statusPageIncidents.statusPageId, page.id),
        eq(statusPageIncidents.status, "resolved"),
        gte(statusPageIncidents.createdAt, thirtyDaysAgo),
      )
    )
    .orderBy(desc(statusPageIncidents.resolvedAt))
    .limit(10);

  const allIncidents = [...activeIncidents, ...resolvedIncidents];

  // Get timeline updates for all incidents
  const incidentIds = allIncidents.map((i) => i.id);
  const allUpdates = incidentIds.length > 0
    ? await db
      .select()
      .from(statusPageUpdates)
      .where(inArray(statusPageUpdates.incidentId, incidentIds))
      .orderBy(desc(statusPageUpdates.createdAt))
    : [];

  // Determine overall status — prioritize active incidents over alert-based logic
  const hasActiveIncidents = activeIncidents.length > 0;
  const hasCriticalIncident = activeIncidents.some((i) => i.severity === "critical");
  const openCritical = recentAlerts.filter((a) => a.severity === "critical" && !a.isResolved);
  const openWarning = recentAlerts.filter((a) => a.severity === "warning" && !a.isResolved);

  const overallStatus =
    hasCriticalIncident || openCritical.length > 0
      ? "major_outage"
      : hasActiveIncidents || openWarning.length > 0
      ? "degraded"
      : "operational";

  const STATUS_CONFIG = {
    operational:  { label: "All Systems Operational", color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", dot: "bg-emerald-500" },
    degraded:     { label: "Degraded Performance",    color: "text-amber-600 dark:text-amber-400",     bg: "bg-amber-500/10 border-amber-500/20",     dot: "bg-amber-500"   },
    major_outage: { label: "Major Outage",            color: "text-red-600 dark:text-red-400",         bg: "bg-red-500/10 border-red-500/20",         dot: "bg-red-500"     },
  };

  const status = STATUS_CONFIG[overallStatus];

  // Build day-by-day alert history (last 7 days)
  const days: { date: string; alerts: typeof recentAlerts }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    days.push({
      date: dateStr,
      alerts: recentAlerts.filter(
        (a) => a.createdAt.toISOString().split("T")[0] === dateStr
      ),
    });
  }

  return (
    <div className="min-h-screen bg-inari-bg">
      <main className="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-fg-strong">{page.title}</h1>
          <p className="mt-1 text-sm text-fg-base">System status for {project.name}</p>
          <p className="mt-1 text-xs text-fg-base/70">
            Last updated {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}
          </p>
        </div>

        {/* Overall status */}
        <div
          className={`mb-8 flex items-center justify-center gap-3 rounded-xl border p-5 ${status.bg}`}
          role="status"
          aria-live="polite"
          aria-label={status.label}
        >
          <span className={`h-3 w-3 rounded-full ${status.dot} animate-pulse`} aria-hidden="true" />
          <span className={`text-lg font-semibold ${status.color}`}>{status.label}</span>
        </div>

        {/* Active incidents */}
        {activeIncidents.length > 0 && (
          <section aria-labelledby="active-incidents-heading" className="mb-8 rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
            <div className="border-b border-red-500/10 px-5 py-3">
              <h2 id="active-incidents-heading" className="text-sm font-medium text-red-600 dark:text-red-400">Active Incidents</h2>
            </div>
            <div className="divide-y divide-red-500/10">
              {activeIncidents.map((incident) => {
                const updates = allUpdates.filter((u) => u.incidentId === incident.id);
                const statusInfo = INCIDENT_STATUS_CONFIG[incident.status] ?? INCIDENT_STATUS_CONFIG.investigating;

                return (
                  <div key={incident.id} className="px-5 py-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="text-sm font-medium text-fg-strong">{incident.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`h-1.5 w-1.5 rounded-full ${statusInfo.dot} animate-pulse`} aria-hidden="true" />
                          <span className={`text-xs font-medium ${statusInfo.color}`}>{statusInfo.label}</span>
                          <span className="text-xs text-fg-base/70">
                            {incident.startedAt?.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                      <span className={`text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded ${
                        incident.severity === "critical" ? "bg-red-500/20 text-red-600 dark:text-red-400" :
                        incident.severity === "major"    ? "bg-amber-500/20 text-amber-600 dark:text-amber-400" :
                        "bg-blue-500/20 text-blue-600 dark:text-blue-400"
                      }`}>
                        {incident.severity}
                      </span>
                    </div>
                    {/* Timeline */}
                    {updates.length > 0 && (
                      <div className="ml-1 border-l border-line pl-4 space-y-3">
                        {updates.slice(0, 5).map((update) => {
                          const uStatus = INCIDENT_STATUS_CONFIG[update.status] ?? INCIDENT_STATUS_CONFIG.investigating;
                          return (
                            <div key={update.id} className="relative">
                              <span className={`absolute -left-[21px] top-1 h-2 w-2 rounded-full ${uStatus.dot}`} aria-hidden="true" />
                              <p className={`text-xs font-medium ${uStatus.color}`}>{uStatus.label}</p>
                              <p className="text-xs text-fg-base mt-0.5">{update.message}</p>
                              <p className="text-[10px] text-fg-base/60 mt-0.5">
                                {update.createdAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Components / integrations */}
        <section aria-labelledby="components-heading" className="mb-8 rounded-xl border border-line bg-inari-card overflow-hidden">
          <div className="border-b border-line px-5 py-3">
            <h2 id="components-heading" className="text-sm font-medium text-fg-base">Components</h2>
          </div>
          <div className="divide-y divide-line-subtle">
            {integrations.length === 0 ? (
              <div className="px-5 py-4 text-center text-sm text-fg-base/70">No components configured</div>
            ) : (
              integrations.map((integ) => {
                const integAlerts = recentAlerts.filter(
                  (a) => a.sourceIntegrations.includes(integ.service) && !a.isResolved
                );
                const integStatus = integAlerts.some((a) => a.severity === "critical")
                  ? "outage"
                  : integAlerts.some((a) => a.severity === "warning")
                  ? "degraded"
                  : "operational";

                return (
                  <div key={integ.id} className="flex items-center justify-between px-5 py-3">
                    <span className="text-sm text-fg-strong capitalize">{integ.service}</span>
                    <span
                      className={`text-xs font-medium ${
                        integStatus === "operational"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : integStatus === "degraded"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {integStatus === "operational" ? "Operational" : integStatus === "degraded" ? "Degraded" : "Outage"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Uptime monitors */}
        {monitors.length > 0 && (
          <section aria-labelledby="uptime-heading" className="mb-8 rounded-xl border border-line bg-inari-card overflow-hidden">
            <div className="border-b border-line px-5 py-3">
              <h2 id="uptime-heading" className="text-sm font-medium text-fg-base">Uptime</h2>
            </div>
            <div className="divide-y divide-line-subtle">
              {monitors.map((monitor) => {
                const monitorChecks = allChecks.filter(c => c.monitorId === monitor.id);
                const uptimePct = monitorChecks.length > 0
                  ? (monitorChecks.filter(c => c.isUp).length / monitorChecks.length * 100)
                  : null;

                // Build 90-day bars
                const days90: (boolean | null)[] = Array.from({ length: 90 }, (_, i) => {
                  const d = new Date();
                  d.setDate(d.getDate() - (89 - i));
                  const dateStr = d.toISOString().split("T")[0];
                  const dayChecks = monitorChecks.filter(c => c.checkedAt.toISOString().split("T")[0] === dateStr);
                  if (dayChecks.length === 0) return null;
                  return dayChecks.every(c => c.isUp);
                });

                const monitorLabel = monitor.name ?? monitor.url;

                return (
                  <div key={monitor.id} className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <p className="text-sm font-medium text-fg-strong">{monitorLabel}</p>
                        <p className="text-xs text-fg-base/70 font-mono truncate max-w-xs">{monitor.url}</p>
                      </div>
                      <div className="text-right">
                        {uptimePct !== null && (
                          <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">{uptimePct.toFixed(2)}%</p>
                        )}
                        <p className={`text-xs ${monitor.isDown ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                          {monitor.isDown ? "Down" : "Operational"}
                        </p>
                      </div>
                    </div>
                    {/* 90-day bar */}
                    <div
                      className="flex items-center gap-px overflow-hidden"
                      role="img"
                      aria-label={`${monitorLabel} — 90 day uptime history${
                        uptimePct !== null ? `, ${uptimePct.toFixed(2)}% overall` : ""
                      }`}
                    >
                      {days90.map((isUp, i) => (
                        <div
                          key={i}
                          title={`Day ${90 - i} ago`}
                          className={`h-6 flex-1 rounded-sm ${
                            isUp === null ? "bg-surface-inner" :
                            isUp ? "bg-emerald-500/70" : "bg-red-500/70"
                          }`}
                          aria-hidden="true"
                        />
                      ))}
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-[10px] text-fg-base/60">90 days ago</span>
                      <span className="text-[10px] text-fg-base/60">Today</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Resolved incidents */}
        {resolvedIncidents.length > 0 && (
          <section aria-labelledby="resolved-heading" className="mb-8 rounded-xl border border-line bg-inari-card overflow-hidden">
            <div className="border-b border-line px-5 py-3">
              <h2 id="resolved-heading" className="text-sm font-medium text-fg-base">Resolved Incidents (30 days)</h2>
            </div>
            <div className="divide-y divide-line-subtle">
              {resolvedIncidents.map((incident) => {
                const updates = allUpdates.filter((u) => u.incidentId === incident.id);
                const duration = incident.resolvedAt && incident.startedAt
                  ? Math.round((incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 60000)
                  : null;

                return (
                  <div key={incident.id} className="px-5 py-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="text-sm font-medium text-fg-strong">{incident.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                          <span className="text-xs text-emerald-600 dark:text-emerald-400">Resolved</span>
                          {duration !== null && (
                            <span className="text-xs text-fg-base/70">
                              {duration < 60 ? `${duration}m` : `${Math.floor(duration / 60)}h ${duration % 60}m`}
                            </span>
                          )}
                          <span className="text-xs text-fg-base/60">
                            {incident.resolvedAt?.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                        </div>
                      </div>
                    </div>
                    {/* Collapsed timeline — show last update only */}
                    {updates.length > 0 && (
                      <p className="text-xs text-fg-base ml-4">{updates[0].message}</p>
                    )}
                    {/* Post-mortem (if available) */}
                    {incident.postmortem && (
                      <details className="mt-3 ml-4">
                        <summary className="text-xs text-fg-base cursor-pointer hover:text-fg-strong transition-colors">
                          View post-mortem
                        </summary>
                        <div className="mt-2 text-xs text-fg-base prose dark:prose-invert prose-xs max-w-none whitespace-pre-wrap border-l-2 border-line pl-3">
                          {incident.postmortem}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Alert history (7 days) */}
        <section aria-labelledby="alert-history-heading" className="rounded-xl border border-line bg-inari-card overflow-hidden">
          <div className="border-b border-line px-5 py-3">
            <h2 id="alert-history-heading" className="text-sm font-medium text-fg-base">Alert History (7 days)</h2>
          </div>
          <div className="divide-y divide-line-subtle">
            {days.map((day) => (
              <div key={day.date} className="px-5 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-fg-base">
                    {new Date(day.date + "T00:00:00").toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  {day.alerts.length === 0 ? (
                    <span className="text-xs text-emerald-700 dark:text-emerald-500">No incidents</span>
                  ) : (
                    <span className="text-xs text-fg-base">{day.alerts.length} incident(s)</span>
                  )}
                </div>
                {day.alerts.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {day.alerts.slice(0, 5).map((a) => (
                      <div key={a.id} className="flex items-start gap-2">
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            a.severity === "critical" ? "bg-red-500" : a.severity === "warning" ? "bg-amber-500" : "bg-blue-500"
                          }`}
                          aria-hidden="true"
                        />
                        <div>
                          <p className="text-xs text-fg-strong">{a.title}</p>
                          <p className="text-xs text-fg-base/70">
                            {a.isResolved ? "Resolved" : "Open"} &middot;{" "}
                            {a.createdAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Footer */}
        <div className="mt-10 border-t border-line pt-6 text-center">
          <a
            href="https://inariwatch.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-xs text-fg-base hover:text-fg-strong transition-colors"
          >
            <span>Powered by</span>
            <span className="font-semibold tracking-wide text-fg-strong">InariWatch</span>
          </a>
          <p className="mt-1 text-[10px] text-fg-base/60">
            Real-time monitoring for developers
          </p>
        </div>
      </main>
    </div>
  );
}
