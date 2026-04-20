import Link from "next/link";
import {
  db, statusPages, statusPageIncidents, statusPageUpdates,
  uptimeMonitors, uptimeChecks, alerts,
} from "@/lib/db";
import { eq, desc, gte, and, ne, inArray, sql } from "drizzle-orm";
import type { Metadata } from "next";

const PAGE_TITLE       = "InariWatch Status";
const PAGE_DESCRIPTION = "Real-time operational status of the InariWatch platform — dashboard, MCP server, webhook ingestion, AI engine, bots, notifications, and cron jobs.";
const PAGE_URL         = "https://inariwatch.com/status";

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
  },
  twitter: {
    card:        "summary_large_image",
    site:        "@inariwatch",
    title:       PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

export const revalidate = 60;

// ── Data ────────────────────────────────────────────────────────────────────────

async function getPlatformData() {
  try {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const last90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const publicPages = await db
    .select({ slug: statusPages.slug, title: statusPages.title, id: statusPages.id })
    .from(statusPages)
    .where(eq(statusPages.isPublic, true))
    .limit(20);

  const [alertStats] = await db
    .select({
      total: sql<number>`count(*)`,
      resolved: sql<number>`count(*) filter (where ${alerts.isResolved} = true)`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, last24h));

  // Active incidents across all public status pages
  const pageIds = publicPages.map((p) => p.id);
  const activeIncidents = pageIds.length > 0
    ? await db
        .select({
          id: statusPageIncidents.id,
          title: statusPageIncidents.title,
          status: statusPageIncidents.status,
          severity: statusPageIncidents.severity,
          startedAt: statusPageIncidents.startedAt,
          statusPageId: statusPageIncidents.statusPageId,
        })
        .from(statusPageIncidents)
        .where(and(
          inArray(statusPageIncidents.statusPageId, pageIds),
          ne(statusPageIncidents.status, "resolved"),
        ))
        .orderBy(desc(statusPageIncidents.createdAt))
        .limit(5)
    : [];

  // Recent resolved incidents (past 7 days)
  const recentResolved = pageIds.length > 0
    ? await db
        .select({
          id: statusPageIncidents.id,
          title: statusPageIncidents.title,
          status: statusPageIncidents.status,
          severity: statusPageIncidents.severity,
          startedAt: statusPageIncidents.startedAt,
          resolvedAt: statusPageIncidents.resolvedAt,
          statusPageId: statusPageIncidents.statusPageId,
        })
        .from(statusPageIncidents)
        .where(and(
          inArray(statusPageIncidents.statusPageId, pageIds),
          eq(statusPageIncidents.status, "resolved"),
          gte(statusPageIncidents.createdAt, last7d),
        ))
        .orderBy(desc(statusPageIncidents.resolvedAt))
        .limit(10)
    : [];

  // Updates for all incidents
  const allIncidents = [...activeIncidents, ...recentResolved];
  const incidentIds = allIncidents.map((i) => i.id);
  const allUpdates = incidentIds.length > 0
    ? await db
        .select()
        .from(statusPageUpdates)
        .where(inArray(statusPageUpdates.incidentId, incidentIds))
        .orderBy(desc(statusPageUpdates.createdAt))
    : [];

  // Uptime monitors
  const allMonitors = await db
    .select({ id: uptimeMonitors.id, name: uptimeMonitors.name, url: uptimeMonitors.url, isDown: uptimeMonitors.isDown })
    .from(uptimeMonitors)
    .where(eq(uptimeMonitors.isActive, true));

  const monitorIds = allMonitors.map((m) => m.id);
  const allChecks = monitorIds.length > 0
    ? await db
        .select({ monitorId: uptimeChecks.monitorId, isUp: uptimeChecks.isUp, checkedAt: uptimeChecks.checkedAt })
        .from(uptimeChecks)
        .where(and(inArray(uptimeChecks.monitorId, monitorIds), gte(uptimeChecks.checkedAt, last90d)))
    : [];

  return {
    publicPages, alertStats, activeIncidents, recentResolved,
    allUpdates, allMonitors, allChecks, anyMonitorDown: allMonitors.some((m) => m.isDown),
  };
  } catch {
    // DB unreachable (e.g., CI build-time prerender with dummy DATABASE_URL)
    // — return a zero-state so the page still renders; ISR on-demand at
    // request time refills with real data.
    return {
      publicPages: [],
      alertStats: { total: 0, resolved: 0 },
      activeIncidents: [],
      recentResolved: [],
      allUpdates: [],
      allMonitors: [],
      allChecks: [],
      anyMonitorDown: false,
    };
  }
}

// ── Services ────────────────────────────────────────────────────────────────────

const SERVICES = [
  { name: "app.inariwatch.com", description: "Dashboard and web application" },
  { name: "mcp.inariwatch.com", description: "MCP server — 25 tools, 4 resources, 7 prompts" },
  { name: "Webhook Ingestion", description: "Sentry, Vercel, GitHub, Datadog, Expo, Capture SDK" },
  { name: "AI Engine", description: "Auto-analysis, diagnosis, remediation" },
  { name: "Slack Bot", description: "Alerts, commands, interactive actions" },
  { name: "Telegram Bot", description: "Alerts, commands, inline actions" },
  { name: "Notifications", description: "Email, web push, mobile push" },
  { name: "Cron Jobs", description: "Pollers, digest, deploy monitor, escalation" },
];

const INCIDENT_COLORS: Record<string, string> = {
  investigating: "#FAA72A",
  identified: "#FAA72A",
  fixing: "#2C84DB",
  monitoring: "#2C84DB",
  resolved: "#76AD2A",
  regressed: "#E04343",
};

const INCIDENT_LABELS: Record<string, string> = {
  investigating: "Investigating",
  identified: "Identified",
  fixing: "Fix in Progress",
  monitoring: "Monitoring",
  resolved: "Resolved",
  regressed: "Regressed",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#E04343",
  major: "#E86235",
  minor: "#FAA72A",
};

// ── Page ────────────────────────────────────────────────────────────────────────

export default async function StatusPage() {
  const {
    publicPages, activeIncidents, recentResolved,
    allUpdates, allMonitors, allChecks, anyMonitorDown,
  } = await getPlatformData();

  const hasCriticalIncident = activeIncidents.some((i) => i.severity === "critical");
  const overallStatus = anyMonitorDown || hasCriticalIncident
    ? "outage"
    : activeIncidents.length > 0
    ? "degraded"
    : "operational";

  // Build 90-day bars per service (aggregate from all monitors)
  function build90DayBars(checks: typeof allChecks) {
    return Array.from({ length: 90 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (89 - i));
      const dateStr = d.toISOString().split("T")[0];
      const dayChecks = checks.filter((c) => c.checkedAt.toISOString().split("T")[0] === dateStr);
      if (dayChecks.length === 0) return { status: "nodata" as const, date: dateStr };
      const upCount = dayChecks.filter((c) => c.isUp).length;
      if (upCount === dayChecks.length) return { status: "operational" as const, date: dateStr };
      if (upCount === 0) return { status: "down" as const, date: dateStr };
      return { status: "degraded" as const, date: dateStr };
    });
  }

  function computeUptime(checks: typeof allChecks) {
    if (checks.length === 0) return null;
    return (checks.filter((c) => c.isUp).length / checks.length) * 100;
  }

  const aggregateBars = build90DayBars(allChecks);
  const aggregateUptime = computeUptime(allChecks);

  // Group past incidents by date
  const pastByDate = new Map<string, typeof recentResolved>();
  for (const inc of recentResolved) {
    const dateStr = (inc.resolvedAt ?? inc.startedAt)?.toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    }) ?? "Unknown";
    if (!pastByDate.has(dateStr)) pastByDate.set(dateStr, []);
    pastByDate.get(dateStr)!.push(inc);
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#FAF9F5", color: "#141413" }}>
      {/* Header */}
      <header style={{ borderBottom: "1px solid #DEDCD1" }}>
        <div className="mx-auto max-w-[760px] px-5 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight" style={{ color: "#141413" }}>
              InariWatch
            </span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-5 py-10">
        {/* Overall status */}
        <div className="mb-10">
          <div
            className="flex items-center gap-3"
            role="status"
            aria-live="polite"
            aria-label={
              overallStatus === "operational" ? "All systems operational"
              : overallStatus === "degraded" ? "Degraded performance"
              : "Partial system outage"
            }
          >
            <div
              className="h-2.5 w-2.5 rounded-full"
              style={{
                backgroundColor: overallStatus === "operational" ? "#5E8B1F"
                  : overallStatus === "degraded" ? "#C77700" : "#C23535",
              }}
              aria-hidden="true"
            />
            <h1 className="text-[28px] font-semibold" style={{ color: "#141413" }}>
              {overallStatus === "operational" ? "All Systems Operational"
                : overallStatus === "degraded" ? "Degraded Performance" : "Partial System Outage"}
            </h1>
          </div>
        </div>

        {/* Active incidents */}
        {activeIncidents.length > 0 && (
          <div className="mb-10">
            {activeIncidents.map((incident) => {
              const updates = allUpdates.filter((u) => u.incidentId === incident.id);
              const color = SEVERITY_COLORS[incident.severity] ?? "#FAA72A";

              return (
                <div key={incident.id} className="mb-6 rounded-lg p-5" style={{
                  backgroundColor: `${color}10`,
                  border: `1px solid ${color}30`,
                }}>
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="text-sm font-semibold" style={{ color }}>{incident.title}</h3>
                    <span className="text-xs font-medium uppercase tracking-wider px-2 py-0.5 rounded"
                      style={{ backgroundColor: `${color}20`, color }}>
                      {incident.severity}
                    </span>
                  </div>
                  {updates.length > 0 && (
                    <div className="space-y-3">
                      {updates.slice(0, 4).map((update) => (
                        <div key={update.id}>
                          <p className="text-xs font-semibold" style={{ color: INCIDENT_COLORS[update.status] ?? "#6B6A62" }}>
                            {INCIDENT_LABELS[update.status] ?? update.status}
                          </p>
                          <p className="text-xs mt-0.5" style={{ color: "#6B6A62" }}>{update.message}</p>
                          <p className="text-[10px] mt-0.5" style={{ color: "#8F8D85" }}>
                            {update.createdAt.toLocaleString("en-US", {
                              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                            })}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Services with uptime bars */}
        <div className="mb-10">
          {SERVICES.map((service, i) => (
            <div key={service.name} className="py-4" style={{
              borderBottom: i < SERVICES.length - 1 ? "1px solid #DEDCD1" : undefined,
            }}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-[15px] font-medium" style={{ color: "#141413" }}>
                    {service.name}
                  </span>
                </div>
                <span className="text-sm" style={{ color: "#5E8B1F" }}>
                  Operational
                </span>
              </div>

              {/* 90-day uptime bar */}
              <div
                className="flex items-center gap-[1.5px]"
                role="img"
                aria-label={`${service.name} — 90 day uptime history${
                  aggregateUptime !== null ? `, ${aggregateUptime.toFixed(2)}% overall` : ""
                }`}
              >
                {aggregateBars.map((day, j) => (
                  <div
                    key={j}
                    className="flex-1 rounded-[1px]"
                    style={{
                      height: "34px",
                      backgroundColor:
                        day.status === "nodata" ? "#E8E6DF"
                        : day.status === "operational" ? "#76AD2A"
                        : day.status === "degraded" ? "#FAA72A"
                        : "#E04343",
                    }}
                    title={`${day.date} — ${
                      day.status === "nodata" ? "No data"
                      : day.status === "operational" ? "No issues"
                      : day.status === "degraded" ? "Partial issues"
                      : "Outage"
                    }`}
                    aria-hidden="true"
                  />
                ))}
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[11px]" style={{ color: "#8F8D85" }}>90 days ago</span>
                <span className="text-[11px]" style={{ color: "#8F8D85" }}>
                  {aggregateUptime !== null ? `${aggregateUptime.toFixed(2)} % uptime` : ""}
                </span>
                <span className="text-[11px]" style={{ color: "#8F8D85" }}>Today</span>
              </div>
            </div>
          ))}
        </div>

        {/* Past incidents */}
        <div>
          <h2 className="text-lg font-semibold mb-6" style={{ color: "#141413" }}>
            Past Incidents
          </h2>

          {pastByDate.size === 0 && activeIncidents.length === 0 ? (
            <div className="py-4">
              <p className="text-sm" style={{ color: "#6B6A62" }}>
                No incidents reported in the past 7 days.
              </p>
            </div>
          ) : (
            Array.from(pastByDate.entries()).map(([dateStr, incidents]) => (
              <div key={dateStr} className="mb-8">
                <h3 className="text-sm font-semibold pb-2 mb-4" style={{
                  color: "#141413",
                  borderBottom: "1px solid #DEDCD1",
                }}>
                  {dateStr}
                </h3>
                {incidents.map((incident) => {
                  const updates = allUpdates.filter((u) => u.incidentId === incident.id);
                  const color = SEVERITY_COLORS[incident.severity] ?? "#FAA72A";

                  return (
                    <div key={incident.id} className="mb-5">
                      <h4 className="text-sm font-semibold mb-2" style={{ color }}>
                        {incident.title}
                      </h4>
                      <div className="space-y-2.5">
                        {updates.map((update) => (
                          <div key={update.id}>
                            <p className="text-xs font-semibold" style={{ color: INCIDENT_COLORS[update.status] ?? "#6B6A62" }}>
                              {INCIDENT_LABELS[update.status] ?? update.status}
                              {" "}
                              <span className="font-normal" style={{ color: "#8F8D85" }}>
                                - {update.createdAt.toLocaleString("en-US", {
                                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                                })}
                              </span>
                            </p>
                            <p className="text-xs mt-0.5" style={{ color: "#6B6A62" }}>{update.message}</p>
                          </div>
                        ))}
                        {updates.length === 0 && (
                          <p className="text-xs" style={{ color: "#6B6A62" }}>
                            Resolved — {incident.resolvedAt?.toLocaleString("en-US", {
                              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                            })}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Project status pages */}
        {publicPages.length > 0 && (
          <div className="mt-10 pt-8" style={{ borderTop: "1px solid #DEDCD1" }}>
            <h2 className="text-sm font-semibold mb-4" style={{ color: "#141413" }}>
              Project Status Pages
            </h2>
            <div className="space-y-2">
              {publicPages.map((p) => (
                <Link
                  key={p.slug}
                  href={`/status/${p.slug}`}
                  className="flex items-center justify-between py-2.5 px-3 rounded-md transition-colors hover:bg-black/[0.03]"
                >
                  <span className="text-sm" style={{ color: "#141413" }}>{p.title}</span>
                  <span className="text-xs" style={{ color: "#6B6A62" }} aria-hidden="true">&rarr;</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-6" style={{ borderTop: "1px solid #DEDCD1" }}>
        <div className="mx-auto max-w-[760px] px-5 py-8 flex items-center justify-between">
          <span className="text-xs" style={{ color: "#8F8D85" }}>
            Powered by InariWatch
          </span>
          <div className="flex items-center gap-5">
            <Link href="/" className="text-xs transition-colors" style={{ color: "#6B6A62" }}>
              Home
            </Link>
            <Link href="/trust" className="text-xs transition-colors" style={{ color: "#6B6A62" }}>
              Trust
            </Link>
            <Link href="/docs" className="text-xs transition-colors" style={{ color: "#6B6A62" }}>
              Docs
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
