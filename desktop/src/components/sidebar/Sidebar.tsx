import { Activity, BookOpen, Inbox, Layers, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { useMainWindow, type MainRoute } from "@/lib/store/mainWindow";

interface NavItem {
  id: MainRoute;
  label: string;
  icon: typeof Inbox;
  /** Cmd/Ctrl + <digit> jumps to this item. */
  shortcut: number;
}

const NAV: NavItem[] = [
  { id: "inbox",    label: "Inbox",    icon: Inbox,         shortcut: 1 },
  { id: "activity", label: "Activity", icon: Activity,      shortcut: 2 },
  { id: "memory",   label: "Memory",   icon: BookOpen,      shortcut: 3 },
  { id: "patterns", label: "Patterns", icon: Layers,        shortcut: 4 },
  { id: "settings", label: "Settings", icon: SettingsIcon,  shortcut: 5 },
];

/**
 * Main window sidebar. Items are tabs into routes the main view renders
 * (Settings is the only fully-realized route in Sesión 17 — Inbox /
 * Activity / Memory / Patterns are placeholders backing onto Sesión-19
 * surfaces).
 *
 * Keyboard:
 *   - Tab / Shift-Tab navigate via the browser's natural focus order.
 *   - Enter / Space activate the focused item.
 *   - Cmd/Ctrl + 1..5 jump straight to the corresponding route.
 */
export function Sidebar() {
  const route = useMainWindow((s) => s.route);
  const setRoute = useMainWindow((s) => s.setRoute);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onGlobalKey(e: globalThis.KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const digit = Number.parseInt(e.key, 10);
      if (!Number.isInteger(digit)) return;
      const item = NAV.find((n) => n.shortcut === digit);
      if (item) {
        e.preventDefault();
        setRoute(item.id);
      }
    }
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  }, [setRoute]);

  function onItemKeyDown(e: KeyboardEvent<HTMLButtonElement>, id: MainRoute) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setRoute(id);
    }
  }

  return (
    <nav
      ref={containerRef}
      data-testid="main-sidebar"
      aria-label="Main navigation"
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
        const selected = item.id === route;
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`sidebar-item-${item.id}`}
            aria-current={selected ? "page" : undefined}
            onClick={() => setRoute(item.id)}
            onKeyDown={(e) => onItemKeyDown(e, item.id)}
            className={cn(
              "flex items-center gap-2 px-2 h-8 rounded-[var(--radius-sm)] text-sm text-left",
              "transition-colors duration-[var(--duration-fast)] outline-none",
              "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
              selected
                ? "bg-[var(--bg)] text-[var(--text)] shadow-[var(--shadow-1)]"
                : "text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            <span className="flex-1">{item.label}</span>
            <kbd className="text-[0.65rem] text-[var(--muted)] tabular-nums">
              ⌘{item.shortcut}
            </kbd>
          </button>
        );
      })}
    </nav>
  );
}
