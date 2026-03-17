import { db, alerts, statusPages, projects, projectIntegrations } from "@/lib/db";
import { eq, and, desc, inArray, gte } from "drizzle-orm";
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
  return { title: page ? `${page.title} — Status` : "Status" };
}

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

  const openCritical = recentAlerts.filter((a) => a.severity === "critical" && !a.isResolved);
  const openWarning = recentAlerts.filter((a) => a.severity === "warning" && !a.isResolved);

  const overallStatus =
    openCritical.length > 0
      ? "major_outage"
      : openWarning.length > 0
      ? "degraded"
      : "operational";

  const STATUS_CONFIG = {
    operational: { label: "All Systems Operational", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20", dot: "bg-green-400" },
    degraded: { label: "Degraded Performance", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", dot: "bg-amber-400" },
    major_outage: { label: "Major Outage", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20", dot: "bg-red-400" },
  };

  const status = STATUS_CONFIG[overallStatus];

  // Build day-by-day incident history (last 7 days)
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
    <div className="min-h-screen bg-[#09090b]">
      <div className="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-white">{page.title}</h1>
          <p className="mt-1 text-sm text-zinc-500">System status for {project.name}</p>
        </div>

        {/* Overall status */}
        <div className={`mb-8 flex items-center justify-center gap-3 rounded-xl border p-5 ${status.bg}`}>
          <span className={`h-3 w-3 rounded-full ${status.dot} animate-pulse`} />
          <span className={`text-lg font-semibold ${status.color}`}>{status.label}</span>
        </div>

        {/* Components / integrations */}
        <div className="mb-8 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
          <div className="border-b border-[#1a1a1a] px-5 py-3">
            <h2 className="text-sm font-medium text-zinc-400">Components</h2>
          </div>
          <div className="divide-y divide-[#131313]">
            {integrations.length === 0 ? (
              <div className="px-5 py-4 text-center text-sm text-zinc-600">No components configured</div>
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
                    <span className="text-sm text-zinc-300 capitalize">{integ.service}</span>
                    <span
                      className={`text-xs font-medium ${
                        integStatus === "operational"
                          ? "text-green-400"
                          : integStatus === "degraded"
                          ? "text-amber-400"
                          : "text-red-400"
                      }`}
                    >
                      {integStatus === "operational" ? "Operational" : integStatus === "degraded" ? "Degraded" : "Outage"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Incident history */}
        <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] overflow-hidden">
          <div className="border-b border-[#1a1a1a] px-5 py-3">
            <h2 className="text-sm font-medium text-zinc-400">Incident History (7 days)</h2>
          </div>
          <div className="divide-y divide-[#131313]">
            {days.map((day) => (
              <div key={day.date} className="px-5 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-zinc-400">
                    {new Date(day.date + "T00:00:00").toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  {day.alerts.length === 0 ? (
                    <span className="text-xs text-green-600">No incidents</span>
                  ) : (
                    <span className="text-xs text-zinc-500">{day.alerts.length} incident(s)</span>
                  )}
                </div>
                {day.alerts.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {day.alerts.slice(0, 5).map((a) => (
                      <div key={a.id} className="flex items-start gap-2">
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            a.severity === "critical" ? "bg-red-400" : a.severity === "warning" ? "bg-amber-400" : "bg-blue-400"
                          }`}
                        />
                        <div>
                          <p className="text-xs text-zinc-400">{a.title}</p>
                          <p className="text-xs text-zinc-600">
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
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-zinc-700">
          Powered by InariWatch
        </p>
      </div>
    </div>
  );
}
