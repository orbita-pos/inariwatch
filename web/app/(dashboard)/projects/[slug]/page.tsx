import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  projectMembers,
  projectInvites,
  users,
  maintenanceWindows,
  escalationRules,
  notificationChannels,
  statusPages,
} from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { MembersSection } from "./members";
import { MaintenanceSection } from "./maintenance";
import { EscalationSection } from "./escalation";
import { StatusPageSection } from "./status-page";
import { ProGate } from "@/components/pro-gate";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) notFound();

  // Get the project
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);

  if (!project) notFound();

  // Check if user is owner or member
  const isOwner = project.userId === userId;
  let isAdmin = isOwner;

  if (!isOwner) {
    const [member] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, project.id),
          eq(projectMembers.userId, userId)
        )
      )
      .limit(1);

    if (!member) notFound();
    isAdmin = member.role === "admin";
  }

  // Get owner info + plan (plan gates Pro features for the project)
  const [owner] = await db
    .select({ id: users.id, name: users.name, email: users.email, plan: users.plan })
    .from(users)
    .where(eq(users.id, project.userId))
    .limit(1);

  const isPro = true; // 100% Free SaaS — all features unlocked

  // Get members with user info
  const members = await db
    .select({
      id: projectMembers.id,
      userId: projectMembers.userId,
      role: projectMembers.role,
      invitedAt: projectMembers.invitedAt,
      acceptedAt: projectMembers.acceptedAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, project.id));

  // Get pending invites
  const pendingInvites = isAdmin
    ? await db
        .select()
        .from(projectInvites)
        .where(eq(projectInvites.projectId, project.id))
    : [];

  // Get maintenance windows (most recent first)
  const mWindows = await db
    .select()
    .from(maintenanceWindows)
    .where(eq(maintenanceWindows.projectId, project.id))
    .orderBy(desc(maintenanceWindows.startsAt));

  // Get escalation rules for this project
  const eRules = await db
    .select()
    .from(escalationRules)
    .where(eq(escalationRules.projectId, project.id));

  // Get status page for this project
  const [statusPage] = await db
    .select()
    .from(statusPages)
    .where(eq(statusPages.projectId, project.id))
    .limit(1);

  // Get user's notification channels (for escalation rule creation)
  const userChannels = await db
    .select({
      id: notificationChannels.id,
      type: notificationChannels.type,
      config: notificationChannels.config,
    })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.isActive, true)
      )
    );

  return (
    <div className="max-w-[680px] space-y-8">
      <div className="flex items-center gap-3">
        <Link
          href="/projects"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#222] text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            {project.name}
          </h1>
          <p className="text-sm text-zinc-500 font-mono">{project.slug}</p>
        </div>
      </div>

      <ProGate isPro={isPro} feature="Team members">
        <MembersSection
          projectId={project.id}
          isAdmin={isAdmin}
          owner={owner ? { name: owner.name, email: owner.email } : null}
          members={members.map((m) => ({
            id: m.id,
            name: m.userName,
            email: m.userEmail,
            role: m.role,
            acceptedAt: m.acceptedAt,
          }))}
          pendingInvites={pendingInvites.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            createdAt: i.createdAt,
          }))}
        />
      </ProGate>

      <MaintenanceSection
        projectId={project.id}
        isAdmin={isAdmin}
        windows={mWindows.map((w) => ({
          id: w.id,
          title: w.title,
          startsAt: w.startsAt,
          endsAt: w.endsAt,
          createdAt: w.createdAt,
        }))}
      />

      <ProGate isPro={isPro} feature="Escalation rules">
        <EscalationSection
          projectId={project.id}
          isAdmin={isAdmin}
          rules={eRules.map((r) => ({
            id: r.id,
            channelId: r.channelId,
            delaySec: r.delaySec,
            minSeverity: r.minSeverity,
            isActive: r.isActive,
            createdAt: r.createdAt,
          }))}
          channels={userChannels.map((ch) => ({
            id: ch.id,
            type: ch.type,
            config: ch.config as Record<string, string>,
          }))}
        />
      </ProGate>

      <ProGate isPro={isPro} feature="Status page">
        <StatusPageSection
          projectId={project.id}
          isAdmin={isAdmin}
          statusPage={statusPage ? {
            id: statusPage.id,
            slug: statusPage.slug,
            title: statusPage.title,
            isPublic: statusPage.isPublic,
          } : null}
        />
      </ProGate>
    </div>
  );
}
