import { Inbox, Activity, BookOpen, Layers, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";

import { CommandPalette } from "@/components/CommandPalette";
import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Main window shell — sidebar + content area. The five sidebar items are
 * Session-17 territory (Inbox / Activity / Memory / Patterns / Settings);
 * Session 14 just hands them an empty placeholder content area each.
 *
 * No router yet (wouter lands when Session 17 needs deep linking). The
 * active section is held in local state.
 */

interface NavItem {
  id: string;
  label: string;
  icon: typeof Inbox;
  /** True for items that have at least a placeholder. */
  ready: boolean;
}

const NAV: NavItem[] = [
  { id: "inbox", label: "Inbox", icon: Inbox, ready: true },
  { id: "activity", label: "Activity", icon: Activity, ready: false },
  { id: "memory", label: "Memory", icon: BookOpen, ready: false },
  { id: "patterns", label: "Patterns", icon: Layers, ready: false },
  { id: "settings", label: "Settings", icon: SettingsIcon, ready: false },
];

export function MainShell() {
  const [active, setActive] = useState("inbox");

  return (
    <div data-testid="main-shell" className="h-full w-full flex">
      <nav
        data-testid="main-sidebar"
        className={cn(
          "w-[220px] shrink-0 h-full border-r border-[var(--border)]",
          "bg-[var(--surface)] p-3 flex flex-col gap-1",
        )}
      >
        <div className="px-2 pb-3 text-xs uppercase tracking-wide text-[var(--muted)]">
          Inari Live
        </div>
        {NAV.map((item) => {
          const Icon = item.icon;
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActive(item.id)}
              className={cn(
                "flex items-center gap-2 px-2 h-8 rounded-[var(--radius-sm)] text-sm text-left",
                "transition-colors duration-[var(--duration-fast)]",
                selected
                  ? "bg-[var(--bg)] text-[var(--text)] shadow-[var(--shadow-1)]"
                  : "text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span className="flex-1">{item.label}</span>
              {!item.ready ? (
                <span className="text-[0.65rem] text-[var(--muted)]">soon</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <ScrollArea className="flex-1 h-full">
        <main className="p-8">
          <h1 className="font-[var(--font-serif)] text-2xl mb-1">
            {NAV.find((n) => n.id === active)?.label}
          </h1>
          <p className="text-sm text-[var(--muted)] max-w-[60ch]">
            Session 14 ships the shell only. Real content arrives in Session 17 (sidebar
            routes) and Sessions 15/16 (alerts / diffs).
          </p>
        </main>
      </ScrollArea>

      <CommandPalette />
    </div>
  );
}
