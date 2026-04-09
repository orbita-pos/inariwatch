import Link from "next/link";
import {
  Activity, CheckCircle2, ArrowRight, ArrowUpRight,
  Shield, Zap, Globe, Bot, Bell, Clock, Server, Webhook,
} from "lucide-react";
import {
  db, statusPages, statusPageIncidents, statusPageUpdates,
  uptimeMonitors, uptimeChecks, alerts,
} from "@/lib/db";
import { eq, desc, gte, and, ne, inArray, sql } from "drizzle-orm";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Platform Status — InariWatch",
  description: "Real-time operational status of the InariWatch platform.",
};

export const revalidate = 60;

// ── Data fetching ──────────────────────────────────────────────────────────────

async function getPlatformData() {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const last90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Public status pages
  const publicPages = await db
    .select({ slug: statusPages.slug, title: statusPages.title, id: statusPages.id })
    .from(statusPages)
    .where(eq(statusPages.isPublic, true))
    .limit(20);

  // Alert stats (24h) — determines real service status
  const [alertStats] = await db
    .select({
      total: sql<number>`count(*)`,
      critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical' and ${alerts.isResolved} = false)`,
      warning: sql<number>`count(*) filter (where ${alerts.severity} = 'warning' and ${alerts.isResolved} = false)`,
      resolved: sql<number>`count(*) filter (where ${alerts.isResolved} = true)`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, last24h));

  // Alert stats (7d) for trend
  const [weekStats] = await db
    .select({
      total: sql<number>`count(*)`,
      resolved: sql<number>`count(*) filter (where ${alerts.isResolved} = true)`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, last7d));

  // Active incidents across all status pages
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

  // Incident updates for active incidents
  const incidentIds = activeIncidents.map((i) => i.id);
  const incidentUpdates = incidentIds.length > 0
    ? await db
        .select()
        .from(statusPageUpdates)
        .where(inArray(statusPageUpdates.incidentId, incidentIds))
        .orderBy(desc(statusPageUpdates.createdAt))
    : [];

  // Platform uptime monitors (all monitors for aggregate uptime)
  const allMonitors = await db
    .select({ id: uptimeMonitors.id, isDown: uptimeMonitors.isDown })
    .from(uptimeMonitors)
    .where(eq(uptimeMonitors.isActive, true));

  const monitorIds = allMonitors.map((m) => m.id);
  const allChecks = monitorIds.length > 0
    ? await db
        .select({
          isUp: uptimeChecks.isUp,
          checkedAt: uptimeChecks.checkedAt,
        })
        .from(uptimeChecks)
        .where(and(
          inArray(uptimeChecks.monitorId, monitorIds),
          gte(uptimeChecks.checkedAt, last90d),
        ))
    : [];

  // Build 90-day bars from aggregate checks
  const days90: ("up" | "down" | "partial" | null)[] = Array.from({ length: 90 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (89 - i));
    const dateStr = d.toISOString().split("T")[0];
    const dayChecks = allChecks.filter(
      (c) => c.checkedAt.toISOString().split("T")[0] === dateStr
    );
    if (dayChecks.length === 0) return null;
    const upCount = dayChecks.filter((c) => c.isUp).length;
    if (upCount === dayChecks.length) return "up";
    if (upCount === 0) return "down";
    return "partial";
  });

  const totalChecks = allChecks.length;
  const upChecks = allChecks.filter((c) => c.isUp).length;
  const uptimePct = totalChecks > 0 ? (upChecks / totalChecks) * 100 : null;

  return {
    publicPages,
    alertStats,
    weekStats,
    activeIncidents,
    incidentUpdates,
    days90,
    uptimePct,
    anyMonitorDown: allMonitors.some((m) => m.isDown),
  };
}

// ── Config ──────────────────────────────────────────────────────────────────────

const SERVICES = [
  { name: "Web App", description: "Dashboard, API routes, SSR", icon: Globe, key: "web" },
  { name: "Webhook Ingestion", description: "Sentry, Vercel, GitHub, Datadog, Expo", icon: Webhook, key: "webhooks" },
  { name: "AI Engine", description: "Diagnosis, remediation, auto-analysis", icon: Zap, key: "ai" },
  { name: "MCP Server", description: "mcp.inariwatch.com — 25 tools", icon: Server, key: "mcp" },
  { name: "Slack Bot", description: "Commands, alerts, interactive actions", icon: Bot, key: "slack" },
  { name: "Telegram Bot", description: "Commands, alerts, inline actions", icon: Bot, key: "telegram" },
  { name: "Notifications", description: "Email, web push, mobile push", icon: Bell, key: "notifications" },
  { name: "Cron Jobs", description: "Pollers, digest, escalation, deploy monitor", icon: Clock, key: "cron" },
];

const INCIDENT_STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  investigating: { label: "Investigating", color: "text-amber-400", dot: "bg-amber-400" },
  identified: { label: "Identified", color: "text-amber-400", dot: "bg-amber-400" },
  fixing: { label: "Fix in Progress", color: "text-blue-400", dot: "bg-blue-400" },
  monitoring: { label: "Monitoring", color: "text-blue-400", dot: "bg-blue-400" },
  regressed: { label: "Regressed", color: "text-red-400", dot: "bg-red-400" },
};

// ── Page ─────────────────────────────────────────────────────────────────────────

export default async function StatusPage() {
  const {
    publicPages, alertStats, weekStats, activeIncidents,
    incidentUpdates, days90, uptimePct, anyMonitorDown,
  } = await getPlatformData();

  const hasCritical = (alertStats?.critical ?? 0) > 0;
  const hasWarning = (alertStats?.warning ?? 0) > 0;
  const hasActiveIncidents = activeIncidents.length > 0;

  const overallStatus = hasCritical || anyMonitorDown
    ? "outage"
    : hasWarning || hasActiveIncidents
    ? "degraded"
    : "operational";

  const STATUS_CONFIG = {
    operational: {
      label: "All Systems Operational",
      color: "text-green-400",
      bg: "border-green-500/20 bg-green-500/5",
      dot: "bg-green-400",
      glow: "shadow-green-500/10",
    },
    degraded: {
      label: "Degraded Performance",
      color: "text-amber-400",
      bg: "border-amber-500/20 bg-amber-500/5",
      dot: "bg-amber-400",
      glow: "shadow-amber-500/10",
    },
    outage: {
      label: "Partial Outage",
      color: "text-red-400",
      bg: "border-red-500/20 bg-red-500/5",
      dot: "bg-red-400",
      glow: "shadow-red-500/10",
    },
  };

  const status = STATUS_CONFIG[overallStatus];

  // Determine per-service status from alert data
  function getServiceStatus(key: string): "operational" | "degraded" | "outage" {
    if (hasCritical && (key === "web" || key === "ai")) return "outage";
    if (hasWarning && (key === "web" || key === "webhooks")) return "degraded";
    if (anyMonitorDown && key === "web") return "outage";
    return "operational";
  }

  const resolvedPct = (weekStats?.total ?? 0) > 0
    ? Math.round(((weekStats?.resolved ?? 0) / (weekStats?.total ?? 1)) * 100)
    : 100;

  return (
    <div className="min-h-screen bg-[#09090b]">
      {/* Header */}
      <header className="border-b border-[#1a1a1a]">
        <div className="mx-auto max-w-3xl px-6 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <Shield className="h-4 w-4 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
            <span className="font-mono font-bold uppercase tracking-[0.2em] text-sm text-zinc-300">
              InariWatch
            </span>
          </Link>
          <span className="text-xs text-zinc-600 font-mono">Status</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* Overall status banner */}
        <div className={`rounded-2xl border p-8 text-center shadow-lg ${status.bg} ${status.glow}`}>
          <div className="flex items-center justify-center gap-3 mb-3">
            <span className={`relative flex h-3 w-3`}>
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status.dot} opacity-75`} />
              <span className={`relative inline-flex rounded-full h-3 w-3 ${status.dot}`} />
            </span>
            <h1 className={`text-2xl font-bold tracking-tight ${status.color}`}>
              {status.label}
            </h1>
          </div>
          <p className="text-xs text-zinc-500 font-mono">
            Updated {new Date().toISOString().replace("T", " ").slice(0, 16)} UTC
          </p>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-3 mt-6">
          <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-4 text-center">
            <p className="text-2xl font-bold text-zinc-200">{uptimePct !== null ? `${uptimePct.toFixed(2)}%` : "—"}</p>
            <p className="text-[11px] text-zinc-600 mt-1">Uptime (90d)</p>
          </div>
          <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-4 text-center">
            <p className="text-2xl font-bold text-zinc-200">{alertStats?.total ?? 0}</p>
            <p className="text-[11px] text-zinc-600 mt-1">Alerts (24h)</p>
          </div>
          <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-4 text-center">
            <p className="text-2xl font-bold text-zinc-200">{resolvedPct}%</p>
            <p className="text-[11px] text-zinc-600 mt-1">Resolved (7d)</p>
          </div>
        </div>

        {/* 90-day uptime bar */}
        {days90.some((d) => d !== null) && (
          <div className="mt-6 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-zinc-300">Uptime — 90 days</h2>
              {uptimePct !== null && (
                <span className={`text-sm font-mono font-semibold ${
                  uptimePct >= 99.9 ? "text-green-400" : uptimePct >= 99 ? "text-amber-400" : "text-red-400"
                }`}>
                  {uptimePct.toFixed(3)}%
                </span>
              )}
            </div>
            <div className="flex items-center gap-[2px] overflow-hidden rounded-md">
              {days90.map((day, i) => (
                <div
                  key={i}
                  className={`h-8 flex-1 transition-colors ${
                    day === null ? "bg-[#1a1a1a]" :
                    day === "up" ? "bg-green-500/70 hover:bg-green-500" :
                    day === "partial" ? "bg-amber-500/70 hover:bg-amber-500" :
                    "bg-red-500/70 hover:bg-red-500"
                  }`}
                  title={(() => {
                    const d = new Date();
                    d.setDate(d.getDate() - (89 - i));
                    return `${d.toISOString().split("T")[0]} — ${day === null ? "No data" : day === "up" ? "Operational" : day === "partial" ? "Partial issues" : "Outage"}`;
                  })()}
                />
              ))}
            </div>
            <div className="flex justify-between mt-2">
              <span className="text-[10px] text-zinc-700 font-mono">90 days ago</span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-[10px] text-zinc-700">
                  <span className="h-2 w-2 rounded-sm bg-green-500/70" /> Up
                </span>
                <span className="flex items-center gap-1 text-[10px] text-zinc-700">
                  <span className="h-2 w-2 rounded-sm bg-amber-500/70" /> Partial
                </span>
                <span className="flex items-center gap-1 text-[10px] text-zinc-700">
                  <span className="h-2 w-2 rounded-sm bg-red-500/70" /> Down
                </span>
                <span className="flex items-center gap-1 text-[10px] text-zinc-700">
                  <span className="h-2 w-2 rounded-sm bg-[#1a1a1a]" /> No data
                </span>
              </div>
              <span className="text-[10px] text-zinc-700 font-mono">Today</span>
            </div>
          </div>
        )}

        {/* Active incidents */}
        {activeIncidents.length > 0 && (
          <div className="mt-6 rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
            <div className="border-b border-red-500/10 px-5 py-3 flex items-center gap-2">
              <Activity className="h-4 w-4 text-red-400" />
              <h2 className="text-sm font-medium text-red-400">Active Incidents</h2>
            </div>
            <div className="divide-y divide-red-500/10">
              {activeIncidents.map((incident) => {
                const updates = incidentUpdates.filter((u) => u.incidentId === incident.id);
                const statusInfo = INCIDENT_STATUS_CONFIG[incident.status] ?? INCIDENT_STATUS_CONFIG.investigating;
                const page = publicPages.find((p) => p.id === incident.statusPageId);

                return (
                  <div key={incident.id} className="px-5 py-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="text-sm font-medium text-zinc-200">{incident.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`h-1.5 w-1.5 rounded-full ${statusInfo.dot} animate-pulse`} />
                          <span className={`text-xs font-medium ${statusInfo.color}`}>{statusInfo.label}</span>
                          {page && (
                            <span className="text-xs text-zinc-600">{page.title}</span>
                          )}
                          <span className="text-xs text-zinc-700">
                            {incident.startedAt?.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                      <span className={`text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded ${
                        incident.severity === "critical" ? "bg-red-500/20 text-red-400" :
                        incident.severity === "major" ? "bg-amber-500/20 text-amber-400" :
                        "bg-blue-500/20 text-blue-400"
                      }`}>
                        {incident.severity}
                      </span>
                    </div>
                    {updates.length > 0 && (
                      <div className="ml-1 border-l border-[#1a1a1a] pl-4 space-y-2 mt-3">
                        {updates.slice(0, 3).map((update) => {
                          const uStatus = INCIDENT_STATUS_CONFIG[update.status] ?? INCIDENT_STATUS_CONFIG.investigating;
                          return (
                            <div key={update.id} className="relative">
                              <span className={`absolute -left-[21px] top-1 h-2 w-2 rounded-full ${uStatus.dot}`} />
                              <p className={`text-xs font-medium ${uStatus.color}`}>{uStatus.label}</p>
                              <p className="text-xs text-zinc-500 mt-0.5">{update.message}</p>
                              <p className="text-[10px] text-zinc-700 mt-0.5">
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
          </div>
        )}

        {/* Services */}
        <div className="mt-6 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
          <div className="border-b border-[#1a1a1a] px-5 py-3">
            <h2 className="text-sm font-medium text-zinc-400">Services</h2>
          </div>
          <div className="divide-y divide-[#131313]">
            {SERVICES.map((service) => {
              const svcStatus = getServiceStatus(service.key);
              const Icon = service.icon;
              return (
                <div key={service.key} className="flex items-center justify-between px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <Icon className="h-4 w-4 text-zinc-600" />
                    <div>
                      <p className="text-sm font-medium text-zinc-300">{service.name}</p>
                      <p className="text-xs text-zinc-600 mt-0.5">{service.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs font-mono ${
                      svcStatus === "operational" ? "text-green-400" :
                      svcStatus === "degraded" ? "text-amber-400" : "text-red-400"
                    }`}>
                      {svcStatus === "operational" ? "Operational" : svcStatus === "degraded" ? "Degraded" : "Outage"}
                    </span>
                    <span className={`h-2 w-2 rounded-full ${
                      svcStatus === "operational" ? "bg-green-400" :
                      svcStatus === "degraded" ? "bg-amber-400" : "bg-red-400"
                    }`} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Project status pages */}
        {publicPages.length > 0 && (
          <div className="mt-6 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
            <div className="border-b border-[#1a1a1a] px-5 py-3">
              <h2 className="text-sm font-medium text-zinc-400">Project Status Pages</h2>
            </div>
            <div className="divide-y divide-[#131313]">
              {publicPages.map((p) => (
                <Link
                  key={p.slug}
                  href={`/status/${p.slug}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-[#111] transition-colors group"
                >
                  <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">{p.title}</span>
                  <ArrowRight className="h-4 w-4 text-zinc-700 group-hover:text-zinc-400 transition-colors" />
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* How we monitor */}
        <div className="mt-10 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">How We Monitor</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-green-400" />
                <p className="text-xs font-medium text-zinc-400">AI Auto-Diagnosis</p>
              </div>
              <p className="text-[11px] text-zinc-600">Every alert analyzed by AI on arrival with root cause and fix suggestion.</p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-blue-400" />
                <p className="text-xs font-medium text-zinc-400">Uptime Checks</p>
              </div>
              <p className="text-[11px] text-zinc-600">HTTP health checks every 60 seconds with auto-heal on consecutive failures.</p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Shield className="h-3.5 w-3.5 text-purple-400" />
                <p className="text-xs font-medium text-zinc-400">Auto-Remediation</p>
              </div>
              <p className="text-[11px] text-zinc-600">AI generates fix, verifies in container, passes 11 safety gates before merge.</p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1a1a1a] mt-6">
        <div className="mx-auto max-w-3xl px-6 py-8 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <Shield className="h-3 w-3" />
            <span>Powered by InariWatch</span>
          </div>
          <div className="flex items-center gap-5 text-xs text-zinc-600">
            <Link href="/" className="hover:text-zinc-300 transition-colors">Home</Link>
            <Link href="/trust" className="hover:text-zinc-300 transition-colors">Trust</Link>
            <Link href="/docs" className="hover:text-zinc-300 transition-colors">Docs</Link>
            <a
              href="https://x.com/InariWatch"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-300 transition-colors flex items-center gap-1"
            >
              Updates <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
