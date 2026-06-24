import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  db,
  projects,
  projectMembers,
  users,
  organizationMembers,
  maintenanceWindows,
  escalationRules,
  notificationChannels,
  statusPages,
  uptimeMonitors,
  uptimeChecks,
  onCallSchedules,
  onCallSlots,
  onCallOverrides,
  alerts,
  remediationSessions,
} from "@/lib/db";
import { eq, and, desc, gte, sql, isNotNull, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ProjectAccessSection } from "./members";
import { MaintenanceSection } from "./maintenance";
import { EscalationSection } from "./escalation";
import { StatusPageSection } from "./status-page";
import { UptimeSection } from "./uptime";
import { OnCallSection } from "./on-call";
import { AutoMergeSection } from "./auto-merge";
import { ConnectedRepoSection } from "./connected-repo";
import { ConnectedCaptureSection } from "./connected-capture";
import { ProjectTokensSection } from "./project-tokens";
import { StagingEnvSection } from "./staging-env";
import { AllowedOriginsSection } from "./allowed-origins";
import { ReplaySettingsSection } from "./replay-settings";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { PostmortemsSection } from "./postmortems";
import { AutonomousSuggestionBanner } from "./autonomous-suggestion";
import { ProGate } from "@/components/pro-gate";
import { getCurrentOnCallUserId } from "@/lib/on-call";
import { DEFAULT_AUTO_MERGE_CONFIG, type AutoMergeConfig, type ReplaySettings } from "@/lib/db/schema";
import { decryptConfig } from "@/lib/crypto";
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
    if (project.organizationId) {
      // Org project: check org membership
      const [orgMember] = await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, project.organizationId),
            eq(organizationMembers.userId, userId)
          )
        )
        .limit(1);

      if (orgMember) {
        isAdmin = orgMember.role === "owner" || orgMember.role === "admin";
      } else {
        // Check project-level access (for restricted projects)
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
    } else {
      notFound(); // Personal project, only owner can access
    }
  }

  // Get owner info (+ their plan — drives Pro-gated project-level settings)
  const [owner] = await db
    .select({ id: users.id, name: users.name, email: users.email, plan: users.plan })
    .from(users)
    .where(eq(users.id, project.userId))
    .limit(1);
  const userPlan: "free" | "pro" = (owner?.plan as "free" | "pro") ?? "free";

  const isOrgProject = !!project.organizationId;

  // Get project access members (for restricted mode display)
  const accessMembers = await db
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      userName: users.name,
      userEmail: users.email,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, project.id));

  // Get all workspace members (for the "grant access" dropdown)
  const workspaceMembers = isOrgProject && project.organizationId
    ? await db
        .select({
          userId: organizationMembers.userId,
          orgRole: organizationMembers.role,
          userName: users.name,
          userEmail: users.email,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(eq(organizationMembers.organizationId, project.organizationId))
    : [];

  // Get maintenance windows (most recent first)
  const mWindows = await db
    .select()
    .from(maintenanceWindows)
    .where(eq(maintenanceWindows.projectId, project.id))
    .orderBy(desc(maintenanceWindows.startsAt));

  // Get escalation rules for this project
  const eRules = await db
    .select({
      id: escalationRules.id,
      targetType: escalationRules.targetType,
      channelId: escalationRules.channelId,
      delaySec: escalationRules.delaySec,
      minSeverity: escalationRules.minSeverity,
      isActive: escalationRules.isActive,
      createdAt: escalationRules.createdAt,
    })
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

  // Get uptime monitors with stats
  const rawMonitors = await db
    .select()
    .from(uptimeMonitors)
    .where(eq(uptimeMonitors.projectId, project.id));

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const monitorsWithStats = await Promise.all(
    rawMonitors.map(async (m) => {
      const checks = await db
        .select({
          total: sql<number>`count(*)`,
          upCount: sql<number>`count(*) filter (where ${uptimeChecks.isUp} = true)`,
          avgMs: sql<number>`avg(${uptimeChecks.responseTimeMs})`,
        })
        .from(uptimeChecks)
        .where(
          and(
            eq(uptimeChecks.monitorId, m.id),
            gte(uptimeChecks.checkedAt, thirtyDaysAgo)
          )
        );

      const total = Number(checks[0]?.total ?? 0);
      const upCount = Number(checks[0]?.upCount ?? 0);
      const avgMs = checks[0]?.avgMs ? Math.round(Number(checks[0].avgMs)) : null;
      const uptimePercent = total > 0 ? (upCount / total) * 100 : null;

      return {
        id: m.id,
        url: m.url,
        name: m.name,
        intervalSec: m.intervalSec,
        expectedStatus: m.expectedStatus,
        isActive: m.isActive,
        isDown: m.isDown,
        lastCheckedAt: m.lastCheckedAt,
        uptimePercent,
        avgResponseMs: avgMs,
      };
    })
  );

  // Get on-call schedules with slots
  const rawSchedules = await db
    .select()
    .from(onCallSchedules)
    .where(eq(onCallSchedules.projectId, project.id));

  const schedulesWithSlots = await Promise.all(
    rawSchedules.map(async (s) => {
      const slots = await db
        .select({
          id: onCallSlots.id,
          userId: onCallSlots.userId,
          level: onCallSlots.level,
          dayStart: onCallSlots.dayStart,
          dayEnd: onCallSlots.dayEnd,
          hourStart: onCallSlots.hourStart,
          hourEnd: onCallSlots.hourEnd,
          userName: users.name,
          userEmail: users.email,
        })
        .from(onCallSlots)
        .innerJoin(users, eq(onCallSlots.userId, users.id))
        .where(eq(onCallSlots.scheduleId, s.id));

      const overrides = await db
        .select({
          id: onCallOverrides.id,
          userId: onCallOverrides.userId,
          level: onCallOverrides.level,
          startsAt: onCallOverrides.startsAt,
          endsAt: onCallOverrides.endsAt,
          userName: users.name,
          userEmail: users.email,
        })
        .from(onCallOverrides)
        .innerJoin(users, eq(onCallOverrides.userId, users.id))
        .where(eq(onCallOverrides.scheduleId, s.id));

      return {
        id: s.id,
        name: s.name,
        timezone: s.timezone,
        slots: slots.map((sl) => ({
          id: sl.id,
          userId: sl.userId,
          level: sl.level,
          userName: sl.userName,
          userEmail: sl.userEmail,
          dayStart: sl.dayStart,
          dayEnd: sl.dayEnd,
          hourStart: sl.hourStart,
          hourEnd: sl.hourEnd,
        })),
        overrides: overrides.map((o) => ({
          id: o.id,
          userId: o.userId,
          level: o.level,
          startsAt: o.startsAt.toISOString(),
          endsAt: o.endsAt.toISOString(),
          userName: o.userName,
          userEmail: o.userEmail,
        })),
      };
    })
  );

  // Resolve who is currently on-call
  const currentOnCallUserId = await getCurrentOnCallUserId(project.id);

  // Get alerts with post-mortems
  const postmortemAlerts = await db
    .select({
      id: alerts.id,
      title: alerts.title,
      severity: alerts.severity,
      postmortem: alerts.postmortem,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, project.id),
        isNotNull(alerts.postmortem),
      )
    )
    .orderBy(desc(alerts.createdAt))
    .limit(20);

  const postmortems = postmortemAlerts.map((a) => ({
    id: a.id,
    alertTitle: a.title,
    severity: a.severity,
    postmortem: a.postmortem!,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: null,
  }));

  const autoMergeConfig = (project.autoMergeConfig as AutoMergeConfig | null) ?? DEFAULT_AUTO_MERGE_CONFIG;

  // Staging env var keys (values are never sent to client)
  const stagingEnvKeys: string[] = project.stagingEnvEncrypted
    ? Object.keys(decryptConfig(project.stagingEnvEncrypted))
    : [];
  const showAutonomousBanner = autoMergeConfig.suggestAutonomous === true && !autoMergeConfig.autoRemediate;

  // Fetch stats for banner text only when needed
  let autonomousStats = { approvalRate: 0, count: 0 };
  if (showAutonomousBanner) {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const [stats] = await db
      .select({
        total:    sql<number>`count(*)`,
        approved: sql<number>`count(*) filter (where status = 'completed')`,
      })
      .from(remediationSessions)
      .where(and(
        eq(remediationSessions.projectId, project.id),
        gte(remediationSessions.createdAt, since),
        inArray(remediationSessions.status, ["completed", "cancelled", "failed"]),
      ));
    const total = Number(stats?.total ?? 0);
    const approved = Number(stats?.approved ?? 0);
    autonomousStats = {
      approvalRate: total > 0 ? Math.round((approved / total) * 100) : 0,
      count: total,
    };
  }

  return (
    <div className="mx-auto max-w-[680px] space-y-8">
      <div className="flex items-center gap-3">
        <Link
          href="/projects"
          aria-label="Back to projects"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-base hover:text-fg-strong hover:border-line-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-fg-strong tracking-tight">
            {project.name}
          </h1>
          <p className="text-sm text-fg-base font-mono">{project.slug}</p>
        </div>
      </div>

      <ProjectAccessSection
        projectId={project.id}
        isAdmin={isAdmin}
        isOrgProject={isOrgProject}
        visibility={project.visibility}
        owner={owner ? { name: owner.name, email: owner.email } : null}
        accessMembers={accessMembers.map((m) => ({
          userId: m.userId,
          name: m.userName,
          email: m.userEmail,
          role: m.role,
        }))}
        workspaceMembers={workspaceMembers.map((m) => ({
          userId: m.userId,
          name: m.userName,
          email: m.userEmail,
          orgRole: m.orgRole,
        }))}
      />

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

      {showAutonomousBanner && (
        <AutonomousSuggestionBanner
          projectId={project.id}
          approvalRate={autonomousStats.approvalRate}
          remediationCount={autonomousStats.count}
        />
      )}

      <AutoMergeSection
        projectId={project.id}
        isAdmin={isAdmin}
        config={autoMergeConfig}
      />

      <ConnectedRepoSection
        projectId={project.id}
        isAdmin={isAdmin}
        defaultRepo={project.defaultRepo ?? null}
      />

      <ConnectedCaptureSection
        projectId={project.id}
        isAdmin={isAdmin}
      />

      <ProjectTokensSection
        projectId={project.id}
        isAdmin={isAdmin}
      />

      <StagingEnvSection
        projectId={project.id}
        isAdmin={isAdmin}
        existingKeys={stagingEnvKeys}
      />

      <AllowedOriginsSection
        projectId={project.id}
        isAdmin={isAdmin}
        replayV2Enabled={isReplayV2Enabled(project.organizationId)}
        initialEntries={project.allowedOrigins ?? []}
      />

      <ReplaySettingsSection
        projectId={project.id}
        isAdmin={isAdmin}
        replayV2Enabled={isReplayV2Enabled(project.organizationId)}
        plan={userPlan}
        initialSettings={(project.replaySettings ?? {}) as ReplaySettings}
      />

      <OnCallSection
        projectId={project.id}
        isAdmin={isAdmin}
        schedules={schedulesWithSlots}
        currentOnCallUserId={currentOnCallUserId}
        workspaceMembers={workspaceMembers.map((m) => ({
          userId: m.userId,
          name: m.userName,
          email: m.userEmail,
        }))}
      />

      <ProGate feature="Escalation rules">
        <EscalationSection
          projectId={project.id}
          isAdmin={isAdmin}
          rules={eRules.map((r) => ({
            id: r.id,
            targetType: r.targetType,
            channelId: r.channelId,
            delaySec: r.delaySec,
            minSeverity: r.minSeverity,
            isActive: r.isActive,
            createdAt: r.createdAt,
          }))}
          channels={userChannels.map((ch) => {
            // Strip sensitive secrets before sending to client component
            const rawConfig = ch.config as Record<string, string>;
            const safeConfig: Record<string, string> = {};
            const sensitiveKeys = new Set(["bot_token", "webhook_url", "access_token", "api_key", "secret", "token", "refresh_token"]);
            for (const [k, v] of Object.entries(rawConfig)) {
              safeConfig[k] = sensitiveKeys.has(k) ? "••••••" : v;
            }
            return { id: ch.id, type: ch.type, config: safeConfig };
          })}
        />
      </ProGate>

      <ProGate feature="Uptime monitoring">
        <UptimeSection
          projectId={project.id}
          isAdmin={isAdmin}
          monitors={monitorsWithStats}
        />
      </ProGate>

      <ProGate feature="Status page">
        <PostmortemsSection postmortems={postmortems} />

        <StatusPageSection
          projectId={project.id}
          isAdmin={isAdmin}
          statusPage={statusPage ? {
            id: statusPage.id,
            slug: statusPage.slug,
            title: statusPage.title,
            isPublic: statusPage.isPublic,
            config: statusPage.config,
          } : null}
        />
      </ProGate>
    </div>
  );
}
