import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { LogOut, Settings, Smartphone } from "lucide-react";
import { SidebarNav } from "./nav";
import { MobileNav } from "./mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { PollingStatus } from "./polling-status";
import { DashboardHeader } from "./dashboard-header";
import { VerifyEmailBanner } from "./settings/verify-email-banner";
import { db, alerts, users, projectIntegrations, getUserOrganizations, getWorkspaceProjectIds } from "@/lib/db";
import { getActiveOrgId } from "@/lib/workspace";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { eq, and, inArray, sql, max } from "drizzle-orm";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const userId = (session?.user as { id?: string })?.id;

  const initials =
    session.user?.name?.[0]?.toUpperCase() ??
    session.user?.email?.[0]?.toUpperCase() ??
    "?";

  const userName = session.user?.name ?? session.user?.email ?? "User";
  const userEmail = session.user?.email ?? "";

  // Fetch user plan + verification status + activeOrgId in one go. The old
  // layout issued this query and then called getActiveOrgId(), which ran
  // getServerSession + a second users-row read — a duplicate JWT decode and
  // a second DB round-trip for a value we already had in scope.
  let userPlan: "free" | "pro" = "free";
  let hasPassword = false;
  let emailVerifiedAt: Date | null = null;
  let activeOrgId: string | null = null;
  if (userId) {
    const [row] = await db
      .select({
        plan: users.plan,
        passwordHash: users.passwordHash,
        emailVerifiedAt: users.emailVerifiedAt,
        activeOrgId: users.activeOrgId,
      })
      .from(users)
      .where(eq(users.id, userId));
    userPlan = (row?.plan as "free" | "pro") ?? "free";
    hasPassword = !!row?.passwordHash;
    emailVerifiedAt = row?.emailVerifiedAt ?? null;
    activeOrgId = row?.activeOrgId ?? null;
  } else {
    // Not signed in — fall back to the cookie-based helper, which handles
    // the anonymous branch. Won't actually run because `redirect("/login")`
    // fired above, but kept for defensive correctness.
    activeOrgId = await getActiveOrgId();
  }
  // Replay V2 is an org-scoped feature — the /replays page requires an
  // activeOrgId to render, so we only show the nav link when both the
  // feature flag AND a workspace are active. Otherwise personal-mode users
  // click a link that 404s.
  const replayV2Enabled = !!activeOrgId && isReplayV2Enabled(activeOrgId);
  const [projectIds, organizations] = userId
    ? await Promise.all([getWorkspaceProjectIds(userId, activeOrgId), getUserOrganizations(userId)])
    : [[], []];

  // Fetch last polling time + unread count in parallel
  let lastCheckedAt: string | null = null;
  let unreadCount = 0;

  if (projectIds.length > 0) {
    const [pollingRow, countRow] = await Promise.all([
      db.select({ last: max(projectIntegrations.lastCheckedAt) })
        .from(projectIntegrations)
        .where(inArray(projectIntegrations.projectId, projectIds)),
      db.select({ count: sql<number>`count(*)` })
        .from(alerts)
        .where(and(
          inArray(alerts.projectId, projectIds),
          eq(alerts.isRead, false),
          eq(alerts.isResolved, false),
        )),
    ]);
    lastCheckedAt = pollingRow[0]?.last?.toISOString() ?? null;
    unreadCount   = countRow[0]?.count ?? 0;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-page">
      {/* Desktop sidebar — hidden on mobile */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[220px] flex-col border-r border-line bg-surface md:flex">
        {/* Workspace switcher */}
        <WorkspaceSwitcher userName={userName} userEmail={userEmail} plan={userPlan} organizations={organizations} activeOrgId={activeOrgId} />

        {/* Nav */}
        <SidebarNav unreadAlerts={unreadCount} isAdmin={!!process.env.ADMIN_EMAIL && userEmail === process.env.ADMIN_EMAIL} activeOrgId={activeOrgId} replayV2Enabled={replayV2Enabled} />

        {/* Polling status */}
        <PollingStatus lastCheckedAt={lastCheckedAt} />

        {/* User */}
        <div className="shrink-0 border-t border-line px-3 py-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-inari-accent text-[11px] font-bold text-white">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg-strong leading-tight">
                {session.user?.name ?? session.user?.email}
              </p>
              {session.user?.name && session.user?.email && (
                <p className="truncate text-[11px] text-fg-base/60 leading-tight">{session.user.email}</p>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              {activeOrgId && (
                <Link
                  href="/settings"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-fg-strong transition-colors"
                  aria-label="Personal settings"
                >
                  <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              )}
              <Link
                href="/download"
                className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-fg-strong transition-colors"
                aria-label="Get mobile app"
              >
                <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
              <ThemeToggle />
              <Link
                href="/api/auth/signout"
                className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-fg-strong transition-colors"
                aria-label="Sign out"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile nav — visible only on mobile */}
      <MobileNav
        unreadAlerts={unreadCount}
        userInitial={initials}
        userName={userName}
        userEmail={userEmail}
        replayV2Enabled={replayV2Enabled}
      />

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden pt-14 pl-0 md:pt-0 md:pl-[220px]">
        <DashboardHeader unreadAlerts={unreadCount} />
        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
          {hasPassword && !emailVerifiedAt && (
            <div className="mb-6">
              <VerifyEmailBanner hasPassword={hasPassword} emailVerifiedAt={emailVerifiedAt} />
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
