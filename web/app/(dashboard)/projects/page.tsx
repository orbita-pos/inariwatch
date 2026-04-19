import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations, alerts } from "@/lib/db";
import { eq, desc, inArray, isNull, and } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { formatRelativeTime } from "@/lib/utils";
import { Github, Zap, AlertTriangle, GitBranch, Bell, Plus, ExternalLink, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateProjectModal } from "../integrations/create-project-modal";
import { DeleteProjectButton } from "./delete-project-button";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Projects" };

const SERVICE_ICON: Record<string, React.ElementType> = {
  github: Github,
  vercel: Zap,
  sentry: AlertTriangle,
  git:    GitBranch,
};

export default async function ProjectsPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const activeOrgId = await getActiveOrgId();

  const userProjects = userId
    ? activeOrgId
      ? await db.select().from(projects).where(eq(projects.organizationId, activeOrgId))
      : await db.select().from(projects).where(and(eq(projects.userId, userId), isNull(projects.organizationId)))
    : [];

  const projectIds = userProjects.map((p) => p.id);

  // The alert list is only used for counts + the most-recent title/timestamp
  // (see projectData.map below). Selecting * pulled message/stackTrace/
  // contextJson for every alert, and at real-world volume that exceeded
  // Neon's 64 MB HTTP response cap (HTTP 507). Narrow projection keeps the
  // payload in the KB range regardless of history size.
  const [allIntegrations, allAlerts] = projectIds.length > 0
    ? await Promise.all([
        db.select().from(projectIntegrations).where(inArray(projectIntegrations.projectId, projectIds)),
        db
          .select({
            id: alerts.id,
            projectId: alerts.projectId,
            title: alerts.title,
            severity: alerts.severity,
            isRead: alerts.isRead,
            createdAt: alerts.createdAt,
          })
          .from(alerts)
          .where(inArray(alerts.projectId, projectIds))
          .orderBy(desc(alerts.createdAt)),
      ])
    : [[], []];

  const projectData = userProjects.map((project) => {
    const integrations  = allIntegrations.filter((i) => i.projectId === project.id);
    const projectAlerts = allAlerts.filter((a) => a.projectId === project.id).slice(0, 50);
    return {
      ...project,
      integrations,
      total:    projectAlerts.length,
      unread:   projectAlerts.filter((a) => !a.isRead).length,
      critical: projectAlerts.filter((a) => a.severity === "critical").length,
      last:     projectAlerts[0] ?? null,
    };
  });

  return (
    <div className="space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-fg-base">
            {userProjects.length} project{userProjects.length !== 1 ? "s" : ""}
          </p>
        </div>
        <CreateProjectModal organizationId={activeOrgId}>
          <Button variant="primary" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New project
          </Button>
        </CreateProjectModal>
      </div>

      {/* ── Empty ──────────────────────────────────────────────────────── */}
      {projectData.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-20 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface-dim">
            <span className="text-base text-fg-base/50" aria-hidden="true">◉</span>
          </div>
          <div>
            <p className="text-sm font-medium text-fg-strong">No projects yet</p>
            <p className="mt-1 text-sm text-fg-base">
              Create a project to start connecting integrations and receiving alerts.
            </p>
          </div>
          <CreateProjectModal organizationId={activeOrgId}>
            <Button variant="primary" size="sm" className="mt-1 gap-1.5">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Create first project
            </Button>
          </CreateProjectModal>
        </div>
      )}

      {/* ── Project list ───────────────────────────────────────────────── */}
      {projectData.length > 0 && (
        <ul className="overflow-hidden rounded-xl border border-line divide-y divide-line-subtle bg-surface">
          {projectData.map((project) => (
            <li
              key={project.id}
              className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02] focus-within:bg-black/[0.02] dark:focus-within:bg-white/[0.02]"
            >
              {/* Status dot */}
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  project.critical > 0               ? "bg-inari-accent" :
                  project.integrations.length > 0    ? "bg-emerald-500"  :
                  "bg-line-medium"
                }`}
                aria-hidden="true"
              />

              {/* Main info — project name is the primary click target */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/projects/${project.slug}`}
                    className="text-sm font-medium text-fg-strong hover:text-inari-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 rounded-sm"
                  >
                    {project.name}
                  </Link>
                  <span className="font-mono text-xs text-fg-base/70">{project.slug}</span>
                </div>

                {project.description && (
                  <p className="mt-0.5 truncate text-xs text-fg-base">{project.description}</p>
                )}

                {/* Integration chips */}
                {project.integrations.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    {project.integrations.map((integ) => {
                      const Icon = SERVICE_ICON[integ.service] ?? Bell;
                      return (
                        <span
                          key={integ.id}
                          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs transition-colors ${
                            integ.isActive
                              ? "border-line-medium bg-surface-dim text-fg-base"
                              : "border-line bg-transparent text-fg-base/50"
                          }`}
                        >
                          <Icon className="h-3 w-3" aria-hidden="true" />
                          {integ.service}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Alert counts */}
              <div className="hidden shrink-0 items-center gap-6 text-center sm:flex">
                <Stat value={project.total}    label="alerts"   />
                <Stat value={project.unread}   label="unread"   accent={project.unread > 0 ? "amber" : undefined} />
                <Stat value={project.critical} label="critical" accent={project.critical > 0 ? "red" : undefined} />
              </div>

              {/* Last alert */}
              <div className="hidden shrink-0 text-right md:block w-40">
                {project.last ? (
                  <>
                    <p className="truncate text-xs text-fg-base">{project.last.title}</p>
                    <p className="mt-0.5 font-mono text-xs text-fg-base/70">
                      {formatRelativeTime(project.last.createdAt)}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-fg-base/50">No alerts</p>
                )}
              </div>

              {/* Actions — visible on hover OR keyboard focus */}
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <ActionBtn href={`/projects/${project.slug}`} title="Project settings" label={`Open ${project.name} settings`}>
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                </ActionBtn>
                <ActionBtn href={`/alerts?project=${project.slug}`} title="View alerts" label={`View alerts for ${project.name}`}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </ActionBtn>
                <DeleteProjectButton projectId={project.id} projectName={project.name} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Stat({ value, label, accent }: { value: number; label: string; accent?: "amber" | "red" }) {
  return (
    <div>
      <p className={`text-sm font-semibold tabular-nums ${
        accent === "red"   ? "text-inari-accent" :
        accent === "amber" ? "text-amber-600 dark:text-amber-400" :
        "text-fg-base"
      }`}>
        {value}
      </p>
      <p className="text-xs text-fg-base/60">{label}</p>
    </div>
  );
}

function ActionBtn({ href, title, label, children }: { href: string; title: string; label: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/70 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.06] hover:text-fg-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
    >
      {children}
    </Link>
  );
}
