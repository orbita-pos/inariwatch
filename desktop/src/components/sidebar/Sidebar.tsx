import {
  Activity,
  BookOpen,
  Inbox,
  Layers,
  PencilLine,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { useCommandPalette } from "@/lib/store/commandPalette";
import { useMainWindow, type MainRoute } from "@/lib/store/mainWindow";

interface NavItem {
  id: MainRoute;
  label: string;
  icon: typeof Inbox;
  /** Cmd/Ctrl + <digit> jumps to this item. */
  shortcut: number;
}

// 5 routes mounted by Inari Live's main window
// (`screens/main/{Inbox,Activity,Memory,Patterns}.tsx` + Settings).
// Settings sits inline with the others (not pinned to a footer) so it
// doesn't get clipped on shorter window heights.
const TOP_NAV: NavItem[] = [
  { id: "inbox",    label: "Inbox",    icon: Inbox,         shortcut: 1 },
  { id: "activity", label: "Activity", icon: Activity,      shortcut: 2 },
  { id: "memory",   label: "Memory",   icon: BookOpen,      shortcut: 3 },
  { id: "patterns", label: "Patterns", icon: Layers,        shortcut: 4 },
  { id: "settings", label: "Settings", icon: SettingsIcon,  shortcut: 5 },
];

const ALL_NAV: NavItem[] = TOP_NAV;

/**
 * Main window sidebar. S33 (2026-05-01) UX overhaul restyles this to mirror
 * Linear's three-column layout (`specs/linear-ux-reference/01-inbox-detail-view.png`)
 * with InariWatch's burnt-orange accent (NOT Linear's purple).
 *
 * Layout: 240px wide, workspace switcher header, search/compose action squares,
 * collapsible "Workspace" section with disclosure caret, dense items
 * (h-7, 13px label, 14px icon, 2px vertical gap), selected = bg --card +
 * 2px left border #ea580c.
 *
 * Keyboard:
 *   - Tab / Shift-Tab navigate via the browser's natural focus order.
 *   - Enter / Space activate the focused item.
 *   - Cmd/Ctrl + 1..5 jump straight to the corresponding route.
 */
export function Sidebar() {
  const route = useMainWindow((s) => s.route);
  const setRoute = useMainWindow((s) => s.setRoute);
  const openPalette = useCommandPalette((s) => s.openWithIntent);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onGlobalKey(e: globalThis.KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const digit = Number.parseInt(e.key, 10);
      if (!Number.isInteger(digit)) return;
      const item = ALL_NAV.find((n) => n.shortcut === digit);
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
      className="w-[240px] shrink-0 h-full flex flex-col border-r border-[var(--border)] bg-[var(--bg)]"
    >
      {/* Workspace switcher header. Mirrors Linear's "Linear ▾ + search +
          compose" header (`01-inbox-detail-view.png` top-left). NO bottom
          border per Jesús — sidebar reads as one continuous panel.
          The whole header is the window drag region so the user can move
          the frameless window by dragging the top edge. */}
      <header
        data-tauri-drag-region
        className="flex items-center gap-1 h-12 px-3"
      >
        {/* Workspace badge — display-only. Inari Live is single-user
            desktop; no workspace switching to surface, so this is a
            <div> not a <button>. The dropdown chevron was removed for
            the same reason — no menu, no caret. */}
        <div
          data-testid="sidebar-workspace-switcher"
          className="flex items-center gap-2 flex-1 h-7 px-1.5"
        >
          <img
            src="/favicon.png"
            alt=""
            width={20}
            height={20}
            className="w-5 h-5 rounded-[var(--radius-sm)] shrink-0 object-contain"
            aria-hidden
          />
          <span className="text-[13px] font-medium text-[var(--text)] truncate">
            Inari
          </span>
        </div>
        <button
          type="button"
          aria-label="Search"
          title="Search (⌘K)"
          data-testid="sidebar-search"
          onClick={() => openPalette("search")}
          className={cn(
            "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
            "text-[var(--text-muted)] hover:text-[var(--text)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:bg-[var(--card)] outline-none cursor-pointer",
            "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          )}
        >
          <Search className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="New fix request"
          title="New fix request"
          data-testid="sidebar-compose"
          onClick={() => openPalette("fix")}
          className={cn(
            "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
            "text-[var(--text-muted)] hover:text-[var(--text)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:bg-[var(--card)] outline-none cursor-pointer",
            "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          )}
        >
          <PencilLine className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>

      {/* Body — Inari Live's 5 main routes inline. Settings is in this
          list (not in a footer tray) so short window heights don't clip it. */}
      <div className="flex-1 flex flex-col px-2 py-3 gap-px overflow-y-auto">
        {TOP_NAV.map((item) => (
          <SidebarItem
            key={item.id}
            item={item}
            selected={item.id === route}
            onSelect={() => setRoute(item.id)}
            onKeyDownActivate={onItemKeyDown}
          />
        ))}
      </div>
    </nav>
  );
}

interface SidebarItemProps {
  item: NavItem;
  selected: boolean;
  onSelect: () => void;
  onKeyDownActivate: (
    e: KeyboardEvent<HTMLButtonElement>,
    id: MainRoute,
  ) => void;
}

function SidebarItem({ item, selected, onSelect, onKeyDownActivate }: SidebarItemProps) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-testid={`sidebar-item-${item.id}`}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      onKeyDown={(e) => onKeyDownActivate(e, item.id)}
      className={cn(
        "group relative flex items-center gap-2 px-2 h-7",
        "rounded-[var(--radius-sm)] text-[13px] text-left cursor-pointer",
        "transition-colors duration-[var(--duration-fast)] outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        // S33: selected = bg --card + 2px left border --accent (orange).
        // Hover (when not selected): bg opacity change ONLY, no scale.
        selected
          ? "bg-[var(--card)] text-[var(--text)]"
          : "text-[var(--text-muted)] hover:bg-[var(--card)] hover:text-[var(--text)]",
      )}
    >
      {selected ? (
        <span
          aria-hidden
          className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r bg-[var(--accent)]"
        />
      ) : null}
      <Icon className="h-[14px] w-[14px] shrink-0" aria-hidden />
      <span className="flex-1 truncate">{item.label}</span>
      <kbd className="text-[10px] tabular-nums text-[var(--text-subtle)] opacity-0 group-hover:opacity-100 transition-opacity duration-[var(--duration-fast)]">
        ⌘{item.shortcut}
      </kbd>
    </button>
  );
}
