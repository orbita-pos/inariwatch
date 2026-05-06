"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Search, ChevronRight } from "lucide-react";
import { SearchDialog } from "./search-dialog";
import { NotificationsBell } from "./notifications-dropdown";
import { ImportFromGitHubButton } from "./import-from-github-button";

// ── Breadcrumb ────────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  dashboard:    "Overview",
  alerts:       "Alerts",
  "on-call":    "On-Call",
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
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const href = "/" + segments.slice(0, i + 1).join("/");
        const label = segmentLabel(seg);

        return (
          <span key={href} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-fg-base/60 shrink-0" aria-hidden="true" />}
            {isLast ? (
              <span className="font-medium text-fg-strong">{label}</span>
            ) : (
              <Link href={href} className="text-fg-base/60 hover:text-fg-base transition-colors">
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

function NewButton({ slug }: { slug?: string }) {
  const pathname = usePathname();

  // Manual project creation was retired — projects are 1:1 with imported
  // GitHub repos. Every "+ New" surface routes through the GitHub App
  // install URL; the setup callback persists the install row and sends
  // the user to /import to pick which repos become projects.
  const label = pathname.startsWith("/integrations") ? "Connect" : "Import from GitHub";
  return <ImportFromGitHubButton slug={slug} label={label} />;
}

// ── Header ────────────────────────────────────────────────────────────────────

interface DashboardHeaderProps {
  unreadAlerts: number;
  githubAppSlug?: string;
}

export function DashboardHeader({ unreadAlerts, githubAppSlug }: DashboardHeaderProps) {
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
            className="hidden lg:flex items-center gap-2 rounded-md border border-line bg-surface-inner px-3 h-8 text-sm text-fg-base/60 hover:text-fg-base hover:border-line-medium transition-colors w-48"
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="text-[10px] text-fg-base/60 font-mono">⌘K</kbd>
          </button>

          {/* Bell */}
          <NotificationsBell unreadCount={unreadAlerts} />

          {/* New button */}
          <NewButton slug={githubAppSlug || undefined} />
        </div>
      </header>
    </>
  );
}
