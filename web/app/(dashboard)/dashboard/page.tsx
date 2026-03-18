import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, projectIntegrations, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { eq, desc, inArray } from "drizzle-orm";
import { formatRelativeTime } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview" };

const SEV = {
  critical: { dot: "bg-inari-accent",   text: "text-inari-accent",   bar: "bg-inari-accent" },
  warning:  { dot: "bg-amber-400", text: "text-amber-400", bar: "bg-amber-400" },
  info:     { dot: "bg-blue-400",  text: "text-blue-400",  bar: "bg-blue-400" },
} as const;
type Sev = keyof typeof SEV;

function timeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  const name    = session?.user?.name?.split(" ")[0] ?? "there";

  const userProjects = userId
    ? await db.select().from(projects).where(eq(projects.userId, userId)).limit(10)
    : [];

  if (userId && userProjects.length === 0) redirect("/onboarding");

  const projectIds = userId ? await getWorkspaceProjectIds(userId, await getActiveOrgId()) : userProjects.map((p) => p.id);

  const [recentAlerts, integrationRows] =
    projectIds.length > 0
      ? await Promise.all([
          db.select().from(alerts).where(inArray(alerts.projectId, projectIds)).orderBy(desc(alerts.createdAt)).limit(8),
          db.select({ id: projectIntegrations.id }).from(projectIntegrations).where(inArray(projectIntegrations.projectId, projectIds)).limit(1),
        ])
      : [[], []];

  const hasProject      = userProjects.length > 0;
  const hasIntegrations = integrationRows.length > 0;
  const unreadCount     = recentAlerts.filter((a) => !a.isRead).length;
  const criticalCount   = recentAlerts.filter((a) => a.severity === "critical").length;
  const openCount       = recentAlerts.filter((a) => !a.isResolved).length;

  return (
    <div className="space-y-8">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg-strong tracking-tight">
            Good {timeOfDay()}, {name}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {hasIntegrations
              ? `Monitoring ${userProjects.length} project${userProjects.length !== 1 ? "s" : ""}`
              : "Connect an integration to start monitoring"}
          </p>
        </div>

        {hasIntegrations && (
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-green-900/40 bg-green-950/20 px-3 py-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
            <span className="text-xs font-medium text-green-400">Watching</span>
          </div>
        )}
      </div>

      {/* ── Stats ────────────────────────────────────────────────────────── */}
      {hasProject && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Projects"
            value={userProjects.length}
            description="monitored"
          />
          <StatCard
            label="Open"
            value={openCount}
            description="active alerts"
          />
          <StatCard
            label="Unread"
            value={unreadCount}
            description="need attention"
            accent={unreadCount > 0 ? "amber" : undefined}
          />
          <StatCard
            label="Critical"
            value={criticalCount}
            description="high severity"
            accent={criticalCount > 0 ? "red" : undefined}
          />
        </div>
      )}

      {/* ── Recent alerts ────────────────────────────────────────────────── */}
      {hasProject && (
        <section>
          <SectionHeader title="Recent alerts" href="/alerts" badge={recentAlerts.length} />

          {recentAlerts.length === 0 ? (
            <EmptyState
              message={hasIntegrations ? "No alerts yet" : "No integrations connected"}
              sub={
                hasIntegrations
                  ? "InariWatch is watching your integrations. Alerts will appear here when something needs attention."
                  : "Connect an integration to start receiving alerts."
              }
              action={!hasIntegrations ? { label: "Connect now", href: "/integrations" } : undefined}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              {recentAlerts.map((alert) => {
                const sev = SEV[(alert.severity as Sev)] ?? SEV.info;
                return (
                  <Link
                    key={alert.id}
                    href={`/alerts/${alert.id}`}
                    className="group relative flex items-center gap-4 border-b border-line-subtle bg-surface px-4 py-3.5 transition-colors last:border-0 hover:bg-black/[0.025] dark:hover:bg-white/[0.025]"
                  >
                    {/* Severity bar */}
                    <span className={`absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full ${sev.bar} opacity-70`} />

                    {/* Dot */}
                    <span className={`ml-1 h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {!alert.isRead && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-inari-accent" />
                        )}
                        <p className="truncate text-sm font-medium text-fg-base group-hover:text-fg-strong transition-colors">
                          {alert.title}
                        </p>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-600">
                        <span className={`font-medium ${sev.text}`}>{alert.severity}</span>
                        <span>·</span>
                        <span className={alert.isResolved ? "text-zinc-600" : "text-amber-500/70"}>
                          {alert.isResolved ? "resolved" : "open"}
                        </span>
                        {alert.sourceIntegrations[0] && (
                          <>
                            <span>·</span>
                            <span className="font-mono">{alert.sourceIntegrations[0]}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Time */}
                    <span className="shrink-0 font-mono text-xs text-zinc-600 transition-colors group-hover:text-zinc-500">
                      {formatRelativeTime(alert.createdAt)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ── Projects ─────────────────────────────────────────────────────── */}
      {hasProject && userProjects.length > 0 && (
        <section>
          <SectionHeader title="Projects" href="/projects" />

          <div className="overflow-hidden rounded-xl border border-line">
            {userProjects.slice(0, 5).map((project) => (
              <Link
                key={project.id}
                href="/projects"
                className="group flex items-center gap-3 border-b border-line-subtle bg-surface px-4 py-3 transition-colors last:border-0 hover:bg-black/[0.025] dark:hover:bg-white/[0.025]"
              >
                <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
                <span className="flex-1 text-sm font-medium text-fg-base transition-colors group-hover:text-fg-strong">
                  {project.name}
                </span>
                <span className="font-mono text-xs text-zinc-600">{project.slug}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ── No projects ──────────────────────────────────────────────────── */}
      {!hasProject && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-24 text-center">
          <span className="text-3xl text-zinc-800">◉</span>
          <p className="text-sm font-medium text-zinc-400">No projects yet</p>
          <p className="text-sm text-zinc-600">
            Go to{" "}
            <Link
              href="/integrations"
              className="text-zinc-400 underline underline-offset-2 transition-colors hover:text-fg-strong"
            >
              Integrations
            </Link>{" "}
            to create your first project.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  href,
  badge,
}: {
  title: string;
  href: string;
  badge?: number;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg-base">{title}</h2>
        {badge !== undefined && badge > 0 && (
          <span className="rounded-full border border-line-medium bg-surface-dim px-2 py-px font-mono text-[11px] text-zinc-500">
            {badge}
          </span>
        )}
      </div>
      <Link
        href={href}
        className="flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-fg-base"
      >
        View all
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

function StatCard({
  label,
  value,
  description,
  accent,
}: {
  label: string;
  value: number;
  description: string;
  accent?: "red" | "amber";
}) {
  const numColor =
    accent === "red"   ? "text-inari-accent" :
    accent === "amber" ? "text-amber-400" :
    "text-fg-strong";

  const borderColor =
    accent === "red"   ? "border-inari-accent/20" :
    accent === "amber" ? "border-amber-900/50" :
    "border-line";

  const bg =
    accent === "red"   ? "bg-inari-accent-dim" :
    accent === "amber" ? "bg-amber-950/20" :
    "bg-surface";

  return (
    <div className={`flex flex-col gap-1.5 rounded-xl border ${borderColor} ${bg} px-4 py-4`}>
      <span className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">
        {label}
      </span>
      <span className={`font-mono text-3xl font-semibold leading-none tabular-nums ${numColor}`}>
        {value}
      </span>
      <span className="text-xs text-zinc-600">{description}</span>
    </div>
  );
}

function EmptyState({
  message,
  sub,
  action,
}: {
  message: string;
  sub: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-10 text-center">
      <p className="text-sm font-medium text-zinc-400">{message}</p>
      <p className="mt-1 text-sm text-zinc-600">{sub}</p>
      {action && (
        <Link
          href={action.href}
          className="mt-3 inline-flex items-center gap-1 text-xs text-zinc-400 underline underline-offset-2 transition-colors hover:text-fg-strong"
        >
          {action.label}
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}
