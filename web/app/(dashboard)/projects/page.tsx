import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, projectIntegrations, alerts } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
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

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-inari-accent",
  warning:  "bg-amber-400",
  info:     "bg-blue-400",
};

export default async function ProjectsPage() {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  const userProjects = userId
    ? await db.select().from(projects).where(eq(projects.userId, userId))
    : [];

  const projectData = await Promise.all(
    userProjects.map(async (project) => {
      const [integrations, projectAlerts] = await Promise.all([
        db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, project.id)),
        db.select().from(alerts).where(eq(alerts.projectId, project.id)).orderBy(desc(alerts.createdAt)).limit(50),
      ]);
      return {
        ...project,
        integrations,
        total:    projectAlerts.length,
        unread:   projectAlerts.filter((a) => !a.isRead).length,
        critical: projectAlerts.filter((a) => a.severity === "critical").length,
        last:     projectAlerts[0] ?? null,
      };
    })
  );

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {userProjects.length} project{userProjects.length !== 1 ? "s" : ""}
          </p>
        </div>
        <CreateProjectModal>
          <Button variant="primary" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> New project
          </Button>
        </CreateProjectModal>
      </div>

      {/* Empty */}
      {projectData.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[#1a1a1a] py-16 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#1a1a1a] bg-[#111]">
            <span className="text-base text-zinc-600">◉</span>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-400">No projects yet</p>
            <p className="mt-1 text-sm text-zinc-600">
              Create a project to start connecting integrations and receiving alerts.
            </p>
          </div>
          <CreateProjectModal>
            <Button variant="primary" size="sm" className="gap-1.5 mt-1">
              <Plus className="h-3.5 w-3.5" /> Create first project
            </Button>
          </CreateProjectModal>
        </div>
      )}

      {/* Project list */}
      {projectData.length > 0 && (
        <div className="rounded-xl border border-[#1a1a1a] overflow-hidden">
          <div className="divide-y divide-[#131313] bg-[#0a0a0a]">
            {projectData.map((project) => (
              <div key={project.id} className="group flex items-center gap-4 px-5 py-4 hover:bg-white/[0.02] transition-colors">

                {/* Status dot */}
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  project.critical > 0 ? SEVERITY_DOT.critical :
                  project.integrations.length > 0 ? "bg-green-500" : "bg-zinc-700"
                }`} />

                {/* Main info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{project.name}</span>
                    <span className="font-mono text-xs text-zinc-600">{project.slug}</span>
                  </div>
                  {project.description && (
                    <p className="mt-0.5 truncate text-xs text-zinc-500">{project.description}</p>
                  )}

                  {/* Integration icons */}
                  {project.integrations.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {project.integrations.map((integ) => {
                        const Icon = SERVICE_ICON[integ.service] ?? Bell;
                        return (
                          <span
                            key={integ.id}
                            className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs transition-colors ${
                              integ.isActive
                                ? "border-[#222] bg-[#111] text-zinc-500"
                                : "border-[#1a1a1a] bg-transparent text-zinc-700"
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
                <div className="hidden shrink-0 items-center gap-5 text-center sm:flex">
                  <div>
                    <p className="text-sm font-semibold tabular-nums text-zinc-300">{project.total}</p>
                    <p className="text-xs text-zinc-600">alerts</p>
                  </div>
                  <div>
                    <p className={`text-sm font-semibold tabular-nums ${project.unread > 0 ? "text-amber-400" : "text-zinc-600"}`}>
                      {project.unread}
                    </p>
                    <p className="text-xs text-zinc-600">unread</p>
                  </div>
                  <div>
                    <p className={`text-sm font-semibold tabular-nums ${project.critical > 0 ? "text-inari-accent" : "text-zinc-600"}`}>
                      {project.critical}
                    </p>
                    <p className="text-xs text-zinc-600">critical</p>
                  </div>
                </div>

                {/* Last alert */}
                <div className="shrink-0 text-right hidden md:block">
                  {project.last ? (
                    <>
                      <p className="text-xs text-zinc-400 line-clamp-1 max-w-[160px]">{project.last.title}</p>
                      <p className="mt-0.5 font-mono text-xs text-zinc-600">
                        {formatRelativeTime(project.last.createdAt)}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-zinc-600">No alerts</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Link
                    href={`/projects/${project.slug}`}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
                    title="Team members"
                  >
                    <Users className="h-3.5 w-3.5" />
                  </Link>
                  <Link
                    href="/alerts"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
                    title="View alerts"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                  <form action={deleteProject.bind(null, project.id)}>
                    <button
                      type="submit"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors"
                      title="Delete project"
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
