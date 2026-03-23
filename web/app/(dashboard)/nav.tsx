"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Bell, BarChart3, Plug, Settings, FolderOpen, MessageSquare, ShieldAlert, Phone } from "lucide-react";

type NavItem = { href: string; label: string; icon: React.ElementType };
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
      { href: "/alerts",    label: "Alerts",     icon: Bell },
      { href: "/on-call",   label: "On-Call",    icon: Phone },
      { href: "/analytics", label: "Analytics",  icon: BarChart3 },
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
];

// Flat list used by mobile nav
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items).concat([
  { href: "/settings", label: "Settings", icon: Settings },
]);

function NavLink({ href, label, icon: Icon }: NavItem) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all ${
        active
          ? "bg-inari-accent/10 text-inari-accent font-medium dark:bg-gradient-to-r dark:from-[#7C3AED] dark:to-violet-500 dark:text-white dark:shadow-[0_2px_10px_rgba(124,58,237,0.35)]"
          : "text-zinc-500 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-fg-base"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </Link>
  );
}

export function SidebarNav({ unreadAlerts: _ = 0, isAdmin = false, activeOrgId }: { unreadAlerts?: number; isAdmin?: boolean; activeOrgId?: string | null }) {
  const settingsHref = activeOrgId ? "/workspace/settings" : "/settings";

  return (
    <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
      {NAV_GROUPS.map((group, i) => (
        <div key={i}>
          {group.label && (
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-600">
              {group.label}
            </p>
          )}
          <div className="space-y-px">
            {group.items.map((item) => (
              <NavLink key={item.href} {...item} />
            ))}
          </div>
        </div>
      ))}

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
