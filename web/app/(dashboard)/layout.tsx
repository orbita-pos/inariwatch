import Link from "next/link";
import Image from "next/image";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { SidebarNav } from "./nav";
import { MobileNav } from "./mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { db, alerts, projects, getUserProjectIds } from "@/lib/db";
import { eq, and, inArray, sql } from "drizzle-orm";

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

  // Count unread alerts for this user's projects (owned + team member)
  let unreadCount = 0;
  if (userId) {
    const projectIds = await getUserProjectIds(userId);

    if (projectIds.length > 0) {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(alerts)
        .where(
          and(
            inArray(alerts.projectId, projectIds),
            eq(alerts.isRead, false),
            eq(alerts.isResolved, false)
          )
        );
      unreadCount = row?.count ?? 0;
    }
  }

  return (
    <div className="flex min-h-screen bg-page">
      {/* Desktop sidebar — hidden on mobile */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[220px] flex-col border-r border-line bg-surface md:flex">
        {/* Logo */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-5">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/logo-inari/favicon-96x96.png"
              alt="InariWatch"
              width={36}
              height={36}
              className="shrink-0"
            />
            <span className="font-mono text-sm font-semibold uppercase tracking-[0.15em] text-fg-strong">
              InariWatch
            </span>
          </Link>
        </div>

        {/* Nav — client component, owns its own icon references */}
        <SidebarNav unreadAlerts={unreadCount} />

        {/* User */}
        <div className="shrink-0 border-t border-line p-3">
          <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-inari-accent text-[11px] font-bold text-white">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg-base">
                {session.user?.name ?? session.user?.email}
              </p>
              {session.user?.name && session.user?.email && (
                <p className="truncate text-xs text-zinc-500">{session.user.email}</p>
              )}
              <p className="text-xs text-zinc-600">Free plan</p>
            </div>
            <div className="flex items-center gap-0.5">
              <ThemeToggle />
              <Link
                href="/api/auth/signout"
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-zinc-400 transition-colors"
                title="Sign out"
              >
                <LogOut className="h-3.5 w-3.5" />
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
      />

      {/* Content */}
      <div className="flex flex-1 flex-col pt-14 pl-0 md:pt-0 md:pl-[220px]">
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
