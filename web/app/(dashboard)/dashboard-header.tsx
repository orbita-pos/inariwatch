"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Plus, Search, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchDialog } from "./search-dialog";
import { NotificationsBell } from "./notifications-dropdown";

// ── Breadcrumb ────────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  dashboard:    "Overview",
  alerts:       "Alerts",
  projects:     "Projects",
  integrations: "Integrations",
  analytics:    "Analytics",
  settings:     "Settings",
  chat:         "Ask Inari",
  onboarding:   "Get Started",
};

function isUUID(s: string) {
  return /^[0-9a-f-]{36}$/i.test(s);
}

function segmentLabel(s: string): string {
  if (isUUID(s)) return s.slice(-6).toUpperCase();
  return LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");
}

function Breadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return <span className="text-sm font-medium text-fg-strong">Overview</span>;

  return (
    <nav className="flex items-center gap-1.5 text-sm">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const href = "/" + segments.slice(0, i + 1).join("/");
        const label = segmentLabel(seg);

        return (
          <span key={href} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-zinc-500 shrink-0" />}
            {isLast ? (
              <span className="font-medium text-fg-strong">{label}</span>
            ) : (
              <Link href={href} className="text-zinc-500 hover:text-fg-base transition-colors">
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ── New button — contextual ───────────────────────────────────────────────────

function NewButton() {
  const pathname = usePathname();

  let href = "/projects";
  let label = "New project";

  if (pathname.startsWith("/integrations")) {
    href  = "/integrations";
    label = "Connect";
  } else if (pathname.startsWith("/projects")) {
    href  = "/projects";
    label = "New project";
  }

  return (
    <Link href={href}>
      <Button variant="primary" size="sm" className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        {label}
      </Button>
    </Link>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

interface DashboardHeaderProps {
  unreadAlerts: number;
}

export function DashboardHeader({ unreadAlerts }: DashboardHeaderProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  // ⌘K / Ctrl+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />

      <header className="sticky top-0 z-30 hidden md:flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface/80 backdrop-blur-md px-6 gap-4">
        {/* Left — breadcrumb */}
        <Breadcrumb />

        {/* Right — actions */}
        <div className="flex items-center gap-2">
          {/* Search trigger */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden lg:flex items-center gap-2 rounded-md border border-line bg-surface-inner px-3 h-8 text-sm text-zinc-500 hover:text-fg-base hover:border-line-medium transition-colors w-48"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="text-[10px] text-zinc-600 font-mono">⌘K</kbd>
          </button>

          {/* Bell */}
          <NotificationsBell unreadCount={unreadAlerts} />

          {/* New button */}
          <NewButton />
        </div>
      </header>
    </>
  );
}
