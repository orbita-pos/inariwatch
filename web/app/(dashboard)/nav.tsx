"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Bell, BarChart3, Plug, Settings, FolderOpen, MessageSquare } from "lucide-react";

export const NAV_ITEMS = [
  { href: "/dashboard",    label: "Overview",     icon: LayoutDashboard },
  { href: "/projects",     label: "Projects",     icon: FolderOpen },
  { href: "/alerts",       label: "Alerts",       icon: Bell },
  { href: "/chat",         label: "Ask Inari",    icon: MessageSquare },
  { href: "/analytics",    label: "Analytics",    icon: BarChart3 },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings",     label: "Settings",     icon: Settings },
];

export function SidebarNav({ unreadAlerts = 0 }: { unreadAlerts?: number }) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 px-2 py-3 space-y-px">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        const showBadge = href === "/alerts" && unreadAlerts > 0;

        return (
          <Link
            key={href}
            href={href}
            className={`group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all ${
              active
                ? "bg-black/[0.06] dark:bg-white/[0.06] text-fg-strong"
                : "text-zinc-500 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] hover:text-fg-base"
            }`}
          >
            {/* Active indicator */}
            {active && (
              <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-inari-accent" />
            )}

            <Icon
              className={`h-4 w-4 shrink-0 transition-colors ${
                active ? "text-inari-accent" : "text-zinc-600 group-hover:text-zinc-400"
              }`}
            />

            <span className={active ? "font-medium text-fg-strong" : ""}>{label}</span>

            {showBadge && (
              <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-inari-accent px-1.5 text-[10px] font-bold text-white">
                {unreadAlerts > 99 ? "99+" : unreadAlerts}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
