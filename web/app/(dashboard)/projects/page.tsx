import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations, alerts } from "@/lib/db";
import { eq, desc, inArray, isNull, and } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { formatRelativeTime } from "@/lib/utils";
import { Github, Zap, AlertTriangle, GitBranch, Bell, Plus, ExternalLink, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateProjectModal } from "../integrations/create-project-modal";
import { deleteProject } from "./actions";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Projects" };

const SERVICE_ICON: Record<string, React.ElementType> = {
  github:  Github,
  vercel:  Zap,
  sentry:  AlertTriangle,
  git:     GitBranch,
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

  const [allIntegrations, allAlerts] = projectIds.length > 0
    ? await Promise.all([
        db.select().from(projectIntegrations).where(inArray(projectIntegrations.projectId, projectIds)),
        db.select().from(alerts).where(inArray(alerts.projectId, projectIds)).orderBy(desc(alerts.createdAt)),
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
          <p className="mt-1 text-sm text-zinc-500">
            {userProjects.length} project{userProjects.length !== 1 ? "s" : ""}
          </p>
        </div>
        <CreateProjectModal organizationId={activeOrgId}>
          <Button variant="primary" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> New project
          </Button>
        </CreateProjectModal>
      </div>

      {/* ── Empty ──────────────────────────────────────────────────────── */}
      {projectData.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-20 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface-dim">
            <span className="text-base text-zinc-600">◉</span>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-400">No projects yet</p>
            <p className="mt-1 text-sm text-zinc-600">
              Create a project to start connecting integrations and receiving alerts.
            </p>
          </div>
          <CreateProjectModal organizationId={activeOrgId}>
            <Button variant="primary" size="sm" className="mt-1 gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Create first project
            </Button>
          </CreateProjectModal>
        </div>
      )}

      {/* ── Project list ───────────────────────────────────────────────── */}
      {projectData.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="divide-y divide-line-subtle bg-surface">
            {projectData.map((project) => (
              <div
                key={project.id}
                className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
              >
                {/* Status dot */}
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  project.critical > 0     ? "bg-inari-accent" :
                  project.integrations.length > 0 ? "bg-green-500" :
                  "bg-zinc-700"
                }`} />

                {/* Main info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-fg-strong">{project.name}</span>
                    <span className="font-mono text-xs text-zinc-600">{project.slug}</span>
                  </div>

                  {project.description && (
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{project.description}</p>
                  )}

                  {/* Integration chips */}
                  {project.integrations.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {project.integrations.map((integ) => {
                        const Icon = SERVICE_ICON[integ.service] ?? Bell;
                        return (
                          <span
                            key={integ.id}
                            className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs transition-colors ${
                              integ.isActive
                                ? "border-line-medium bg-surface-dim text-zinc-500"
                                : "border-line bg-transparent text-zinc-700"
                            }`}
                          >
                            <Icon className="h-3 w-3" />
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
                <div className="hidden shrink-0 text-right md:block" style={{ width: "160px" }}>
                  {project.last ? (
                    <>
                      <p className="truncate text-xs text-zinc-400">{project.last.title}</p>
                      <p className="mt-0.5 font-mono text-xs text-zinc-600">
                        {formatRelativeTime(project.last.createdAt)}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-zinc-700">No alerts</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <ActionBtn href={`/projects/${project.slug}`} title="Team members">
                    <Users className="h-3.5 w-3.5" />
                  </ActionBtn>
                  <ActionBtn href="/alerts" title="View alerts">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </ActionBtn>
                  <form action={deleteProject.bind(null, project.id)}>
                    <button
                      type="submit"
                      title="Delete project"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-red-400/[0.06] hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </div>
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
        accent === "amber" ? "text-amber-400" :
        "text-zinc-500"
      }`}>
        {value}
      </p>
      <p className="text-xs text-zinc-700">{label}</p>
    </div>
  );
}

function ActionBtn({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.06] hover:text-fg-base"
    >
      {children}
    </Link>
  );
}
