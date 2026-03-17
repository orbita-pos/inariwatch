import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, projectIntegrations, getUserProjectIds } from "@/lib/db";
import { eq, desc, inArray } from "drizzle-orm";
import { formatRelativeTime } from "@/lib/utils";
import { ArrowUpRight, FolderOpen } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview" };

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-400",
  info:     "bg-blue-400",
};
const SEVERITY_TEXT: Record<string, string> = {
  critical: "text-inari-accent",
  warning:  "text-amber-400",
  info:     "text-blue-400",
};

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  const name    = session?.user?.name?.split(" ")[0] ?? "there";

  const userProjects = userId
    ? await db.select().from(projects).where(eq(projects.userId, userId)).limit(10)
    : [];

  // Redirect new users (no projects) to onboarding wizard
  if (userId && userProjects.length === 0) {
    redirect("/onboarding");
  }

  // Include team projects for alerts
  const projectIds = userId ? await getUserProjectIds(userId) : userProjects.map((p) => p.id);

  const recentAlerts =
    projectIds.length > 0
      ? await db
          .select()
          .from(alerts)
          .where(inArray(alerts.projectId, projectIds))
          .orderBy(desc(alerts.createdAt))
          .limit(8)
      : [];

  const hasProject       = userProjects.length > 0;
  const hasIntegrations  =
    projectIds.length > 0
      ? (await db
          .select({ id: projectIntegrations.id })
          .from(projectIntegrations)
          .where(inArray(projectIntegrations.projectId, projectIds))
          .limit(1)
        ).length > 0
      : false;

  const unreadCount   = recentAlerts.filter((a) => !a.isRead).length;
  const criticalCount = recentAlerts.filter((a) => a.severity === "critical").length;

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-tight">Overview</h1>
          <p className="text-sm text-zinc-500 mt-1">Welcome back, {name}</p>
        </div>
        <span className="hidden shrink-0 font-mono text-xs text-zinc-600 sm:block">
          {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
        </span>
      </div>

      {/* Stats */}
      {hasProject && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Projects", value: userProjects.length, sub: "total" },
            { label: "Alerts",   value: recentAlerts.length, sub: "last fetch" },
            { label: "Unread",   value: unreadCount,         sub: "need attention", accent: unreadCount > 0 },
            { label: "Critical", value: criticalCount,       sub: "high severity",  red: criticalCount > 0 },
          ].map(({ label, value, sub, accent, red }) => (
            <div key={label} className="flex flex-col gap-1 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-3 py-3 sm:px-5 sm:py-4">
              <span className="text-xs text-zinc-500">{label}</span>
              <span className={`text-2xl font-semibold tabular-nums ${
                red ? "text-inari-accent" : accent ? "text-amber-400" : "text-white"
              }`}>
                {value}
              </span>
              <span className="text-xs text-zinc-600">{sub}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent alerts */}
      {hasProject && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-200">Recent alerts</h2>
            <Link href="/alerts" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              View all <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {recentAlerts.length === 0 ? (
            <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] px-5 py-10 text-center">
              <p className="text-sm text-zinc-400">No alerts yet</p>
              <p className="mt-1 text-sm text-zinc-600">
                {hasIntegrations
                  ? "InariWatch is watching your integrations. Alerts will appear here when something needs attention."
                  : "Connect an integration to start receiving alerts."
                }
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-[#1a1a1a] overflow-hidden divide-y divide-[#131313] bg-[#0a0a0a]">
              {recentAlerts.map((alert) => (
                <Link
                  key={alert.id}
                  href={`/alerts/${alert.id}`}
                  className="group flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[alert.severity] ?? "bg-zinc-600"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-zinc-200 group-hover:text-white transition-colors">
                      {alert.title}
                      {!alert.isRead && (
                        <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-inari-accent align-middle" />
                      )}
                    </p>
                    {alert.body && (
                      <p className="mt-0.5 truncate text-xs text-zinc-500">{alert.body}</p>
                    )}
                  </div>
                  <div className="hidden shrink-0 items-center gap-1 md:flex">
                    {alert.sourceIntegrations.slice(0, 2).map((src) => (
                      <span key={src} className="rounded border border-[#222] bg-[#111] px-1.5 py-0.5 font-mono text-xs text-zinc-500">
                        {src}
                      </span>
                    ))}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`text-xs font-medium ${SEVERITY_TEXT[alert.severity] ?? "text-zinc-500"}`}>
                      {alert.severity}
                    </p>
                    <p className="font-mono text-xs text-zinc-600">
                      {formatRelativeTime(alert.createdAt)}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Projects */}
      {hasProject && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-200">Projects</h2>
            <Link href="/projects" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              View all <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {userProjects.slice(0, 4).map((project) => (
              <Link
                key={project.id}
                href="/projects"
                className="group flex flex-col gap-2 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-4 hover:border-[#2a2a2a] transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-3.5 w-3.5 text-zinc-600" />
                    <span className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">
                      {project.name}
                    </span>
                  </div>
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                </div>
                <p className="font-mono text-xs text-zinc-600">{project.slug}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {!hasProject && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[#1a1a1a] py-24 text-center">
          <span className="text-3xl text-zinc-800">◉</span>
          <p className="text-sm font-medium text-zinc-400">No projects yet</p>
          <p className="text-sm text-zinc-600">
            Go to <Link href="/integrations" className="text-zinc-400 hover:text-white transition-colors underline underline-offset-2">Integrations</Link> to create your first project.
          </p>
        </div>
      )}
    </div>
  );
}
