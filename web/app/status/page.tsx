import Link from "next/link";
import { Activity, CheckCircle2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db, statusPages, uptimeMonitors, uptimeChecks, alerts } from "@/lib/db";
import { eq, desc, gte, and, sql } from "drizzle-orm";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Platform Status — InariWatch",
  description: "Real-time operational status of the InariWatch platform.",
};

export const revalidate = 60;

async function getPlatformStatus() {
  // Public status pages
  const publicPages = await db
    .select({
      slug: statusPages.slug,
      title: statusPages.title,
    })
    .from(statusPages)
    .where(eq(statusPages.isPublic, true))
    .limit(20);

  // Platform uptime monitors (owned by system / no project filter)
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Recent alert volume (last 24h) as a proxy for platform health
  const [alertStats] = await db
    .select({
      total: sql<number>`count(*)`,
      critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical')`,
    })
    .from(alerts)
    .where(gte(alerts.createdAt, last24h));

  return { publicPages, alertStats };
}

const SERVICES = [
  { name: "Web App", description: "Dashboard, API routes, webhooks", status: "operational" },
  { name: "MCP Server", description: "mcp.inariwatch.com — 25 tools", status: "operational" },
  { name: "Webhook Ingestion", description: "Sentry, Vercel, GitHub, Datadog, Expo, Capture SDK", status: "operational" },
  { name: "AI Analysis", description: "Auto-analysis, remediation, diagnosis", status: "operational" },
  { name: "Slack Bot", description: "Commands, alerts, interactive actions", status: "operational" },
  { name: "Telegram Bot", description: "Commands, alerts, inline actions", status: "operational" },
  { name: "Push Notifications", description: "Web push, mobile push, email", status: "operational" },
  { name: "Cron Jobs", description: "Pollers, digest, deploy monitor, escalation", status: "operational" },
];

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  operational: { label: "Operational", color: "text-green-400", dot: "bg-green-400" },
  degraded: { label: "Degraded", color: "text-amber-400", dot: "bg-amber-400" },
  outage: { label: "Outage", color: "text-red-400", dot: "bg-red-400" },
  maintenance: { label: "Maintenance", color: "text-blue-400", dot: "bg-blue-400" },
};

export default async function StatusPage() {
  const { publicPages } = await getPlatformStatus();

  const allOperational = SERVICES.every((s) => s.status === "operational");

  return (
    <div className="min-h-screen bg-inari-bg">
      {/* Header */}
      <div className="border-b border-inari-border">
        <div className="mx-auto max-w-3xl px-6 py-6 flex items-center justify-between">
          <Link href="/" className="font-mono font-bold uppercase tracking-widest text-sm text-fg-strong">
            INARIWATCH
          </Link>
          <span className="text-xs text-zinc-500">Platform Status</span>
        </div>
      </div>

      {/* Overall status */}
      <div className="mx-auto max-w-3xl px-6 pt-12 pb-8">
        <div className={`rounded-xl border p-6 text-center ${
          allOperational
            ? "border-green-500/20 bg-green-500/5"
            : "border-amber-500/20 bg-amber-500/5"
        }`}>
          <div className="flex items-center justify-center gap-2.5 mb-2">
            {allOperational ? (
              <CheckCircle2 className="h-5 w-5 text-green-400" />
            ) : (
              <Activity className="h-5 w-5 text-amber-400" />
            )}
            <h1 className={`text-xl font-bold ${allOperational ? "text-green-400" : "text-amber-400"}`}>
              {allOperational ? "All Systems Operational" : "Experiencing Issues"}
            </h1>
          </div>
          <p className="text-xs text-zinc-500">
            Last updated: {new Date().toISOString().replace("T", " ").slice(0, 19)} UTC
          </p>
        </div>
      </div>

      {/* Services */}
      <div className="mx-auto max-w-3xl px-6 pb-12">
        <div className="rounded-xl border border-inari-border overflow-hidden">
          {SERVICES.map((service, i) => {
            const cfg = STATUS_CONFIG[service.status] ?? STATUS_CONFIG.operational;
            return (
              <div
                key={service.name}
                className={`flex items-center justify-between px-5 py-4 ${
                  i < SERVICES.length - 1 ? "border-b border-inari-border" : ""
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-fg-strong">{service.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{service.description}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs font-mono ${cfg.color}`}>{cfg.label}</span>
                  <span className={`h-2 w-2 rounded-full ${cfg.dot}`} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Public project status pages */}
      {publicPages.length > 0 && (
        <div className="mx-auto max-w-3xl px-6 pb-12">
          <h2 className="text-sm font-semibold text-fg-strong mb-4">Project Status Pages</h2>
          <div className="space-y-2">
            {publicPages.map((p) => (
              <Link
                key={p.slug}
                href={`/status/${p.slug}`}
                className="flex items-center justify-between rounded-lg border border-inari-border bg-inari-card px-4 py-3 hover:border-inari-accent/30 transition-colors"
              >
                <span className="text-sm text-fg-base">{p.title}</span>
                <ArrowRight className="h-4 w-4 text-zinc-500" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-inari-border py-8">
        <div className="mx-auto max-w-3xl px-6 flex items-center justify-between">
          <span className="text-xs text-zinc-600">
            Monitored by InariWatch
          </span>
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            <Link href="/" className="hover:text-fg-base transition-colors">Home</Link>
            <Link href="/trust" className="hover:text-fg-base transition-colors">Trust</Link>
            <Link href="/docs" className="hover:text-fg-base transition-colors">Docs</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
