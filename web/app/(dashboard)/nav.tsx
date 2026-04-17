"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Bell, BarChart3, Plug, Settings, FolderOpen, MessageSquare, ShieldAlert, Phone, Users, Activity, Film } from "lucide-react";

type NavItem  = { href: string; label: string; icon: React.ElementType; exact?: boolean; badge?: number; flag?: "replayV2" };
type NavGroup = { label?: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
    ],
  },
  {
    label: "Monitor",
    items: [
      { href: "/alerts",    label: "Alerts",    icon: Bell },
      { href: "/sessions",  label: "Sessions",  icon: Film, flag: "replayV2" },
      { href: "/on-call",   label: "On-Call",   icon: Phone },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/projects",     label: "Projects",     icon: FolderOpen },
      { href: "/integrations", label: "Integrations", icon: Plug },
    ],
  },
  {
    label: "AI",
    items: [
      { href: "/chat", label: "Ask Inari", icon: MessageSquare },
    ],
  },
  {
    label: "Learn",
    items: [
      { href: "/community",       label: "Community",   icon: Users,    exact: true },
      { href: "/community/fleet", label: "Fleet Stats", icon: Activity },
    ],
  },
];

// Flat list used by mobile nav. Filter applied at render time based on
// the viewer's active-org flag state (see MobileNav).
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items).concat([
  { href: "/settings", label: "Settings", icon: Settings },
]);

function isItemVisible(item: NavItem, flags: { replayV2: boolean }): boolean {
  if (item.flag === "replayV2") return flags.replayV2;
  return true;
}

function NavLink({ href, label, icon: Icon, exact, badge }: NavItem) {
  const pathname = usePathname();
  const active = pathname === href || (!exact && pathname.startsWith(href + "/"));

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all ${
        active
          ? "bg-inari-accent/10 text-inari-accent font-medium"
          : "text-fg-base/60 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-fg-base"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
          {badge > 99 ? "99+" : badge}
          <span className="sr-only"> unread alerts</span>
        </span>
      )}
    </Link>
  );
}

export function SidebarNav({
  unreadAlerts = 0,
  isAdmin = false,
  activeOrgId,
  replayV2Enabled = false,
}: {
  unreadAlerts?: number;
  isAdmin?: boolean;
  activeOrgId?: string | null;
  replayV2Enabled?: boolean;
}) {
  const settingsHref = activeOrgId ? "/workspace/settings" : "/settings";
  const flags = { replayV2: replayV2Enabled };

  return (
    <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
      {NAV_GROUPS.map((group, i) => {
        const visible = group.items.filter((item) => isItemVisible(item, flags));
        if (visible.length === 0) return null;
        return (
          <div key={i}>
            {group.label && (
              <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-fg-base/40">
                {group.label}
              </p>
            )}
            <div className="space-y-px">
              {visible.map((item) => (
                <NavLink
                  key={item.href}
                  {...item}
                  badge={item.href === "/alerts" ? unreadAlerts : undefined}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Settings — always at the bottom of the nav */}
      <div className="space-y-px">
        <NavLink href={settingsHref} label="Settings" icon={Settings} />
        {isAdmin && (
          <NavLink href="/admin" label="Admin" icon={ShieldAlert} />
        )}
      </div>
    </nav>
  );
}
