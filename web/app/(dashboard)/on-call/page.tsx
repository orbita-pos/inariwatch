import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, projects, onCallSchedules, users, getWorkspaceProjectIds } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { getActiveOrgId } from "@/lib/workspace";
import { getCurrentOnCallUserId } from "@/lib/on-call";
import Link from "next/link";
import { Phone, CalendarDays, ArrowUpRight } from "lucide-react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "On-Call" };

export default async function OnCallPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;

  if (!userId) redirect("/login");

  const activeOrgId = await getActiveOrgId();
  const projectIds = await getWorkspaceProjectIds(userId, activeOrgId);

  const userProjects =
    projectIds.length > 0
      ? await db.select().from(projects).where(inArray(projects.id, projectIds))
      : [];

  const schedules =
    projectIds.length > 0
      ? await db.select().from(onCallSchedules).where(inArray(onCallSchedules.projectId, projectIds))
      : [];

  const onCallStatus = await Promise.all(
    userProjects.map(async (p) => {
      const projectSchedules = schedules.filter((s) => s.projectId === p.id);
      if (projectSchedules.length === 0) {
        return { project: p, onCallUserId: null, scheduleName: null };
      }
      const firstSchedule = projectSchedules[0];
      try {
        const onCallUserId = await getCurrentOnCallUserId(p.id, 1);
        return { project: p, onCallUserId, scheduleName: firstSchedule.name };
      } catch {
        return { project: p, onCallUserId: null, scheduleName: firstSchedule.name };
      }
    })
  );

  const onCallUserIds = onCallStatus
    .map((s) => s.onCallUserId)
    .filter(Boolean) as string[];

  const onCallUsers =
    onCallUserIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, onCallUserIds))
      : [];

  const userMap = new Map(onCallUsers.map((u) => [u.id, u]));

  return (
    <div className="max-w-[680px] space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">On-Call</h1>
          <p className="mt-1 text-sm text-zinc-500">Who&apos;s on-call right now across your projects.</p>
        </div>
      </div>

      {onCallStatus.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line py-16 text-center">
          <Phone className="mx-auto mb-3 h-8 w-8 text-zinc-700" />
          <p className="text-sm font-medium text-zinc-400">No projects yet</p>
          <p className="mt-1 text-sm text-zinc-600">Create a project to configure on-call schedules.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line divide-y divide-line-subtle">
          {onCallStatus.map(({ project, onCallUserId, scheduleName }) => {
            const onCallUser = onCallUserId ? userMap.get(onCallUserId) : null;
            const hasSchedule = scheduleName !== null;
            return (
              <div key={project.id} className="flex items-center gap-4 bg-surface px-5 py-4">
                <div
                  className={`flex h-2.5 w-2.5 shrink-0 rounded-full ${
                    onCallUser
                      ? "bg-emerald-400 animate-pulse"
                      : hasSchedule
                      ? "bg-amber-400"
                      : "bg-zinc-600"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-fg-base">{project.name}</p>
                  {onCallUser ? (
                    <p className="text-xs text-emerald-400 font-medium">
                      {onCallUser.name ?? onCallUser.email} is on-call
                      {scheduleName && (
                        <span className="text-zinc-600 font-normal"> · {scheduleName}</span>
                      )}
                    </p>
                  ) : hasSchedule ? (
                    <p className="text-xs text-amber-400">Schedule configured, no one on-call now</p>
                  ) : (
                    <p className="text-xs text-zinc-600">No schedule configured</p>
                  )}
                </div>
                <Link
                  href={`/projects/${project.slug}#on-call`}
                  className="flex items-center gap-1 text-xs text-zinc-500 hover:text-fg-base transition-colors shrink-0"
                >
                  Configure
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-line bg-surface px-5 py-4">
        <div className="flex items-start gap-3">
          <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          <div>
            <p className="text-sm font-medium text-fg-base">Configure on-call schedules</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              Set up rotations, time slots, and overrides from each project&apos;s settings page.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
