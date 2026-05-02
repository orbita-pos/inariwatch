import {
  Activity,
  BookOpen,
  ChevronDown,
  Inbox,
  Layers,
  PencilLine,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { useMainWindow, type MainRoute } from "@/lib/store/mainWindow";

interface NavItem {
  id: MainRoute;
  label: string;
  icon: typeof Inbox;
  /** Cmd/Ctrl + <digit> jumps to this item. */
  shortcut: number;
}

const WORKSPACE_NAV: NavItem[] = [
  { id: "inbox",    label: "Inbox",    icon: Inbox,    shortcut: 1 },
  { id: "activity", label: "Activity", icon: Activity, shortcut: 2 },
  { id: "memory",   label: "Memory",   icon: BookOpen, shortcut: 3 },
  { id: "patterns", label: "Patterns", icon: Layers,   shortcut: 4 },
];

const PINNED_NAV: NavItem[] = [
  { id: "settings", label: "Settings", icon: SettingsIcon, shortcut: 5 },
];

const ALL_NAV: NavItem[] = [...WORKSPACE_NAV, ...PINNED_NAV];

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
  const containerRef = useRef<HTMLElement | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);

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
          compose" header (`01-inbox-detail-view.png` top-left).
          The whole header is the window drag region so the user can move
          the frameless window by dragging the top edge — matches macOS /
          Windows native UX without showing a title bar. */}
      <header
        data-tauri-drag-region
        className="flex items-center gap-1 h-12 px-3 border-b border-[var(--border-subtle)]"
      >
        <button
          type="button"
          data-testid="sidebar-workspace-switcher"
          className={cn(
            "flex items-center gap-2 flex-1 h-7 px-1.5 rounded-[var(--radius-sm)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:bg-[var(--card)] outline-none",
            "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          )}
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
            Inari Live
          </span>
          <ChevronDown className="h-3 w-3 text-[var(--text-subtle)] shrink-0" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Search"
          data-testid="sidebar-search"
          className={cn(
            "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
            "text-[var(--text-muted)] hover:text-[var(--text)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:bg-[var(--card)] outline-none",
            "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          )}
        >
          <Search className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Compose"
          data-testid="sidebar-compose"
          className={cn(
            "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
            "text-[var(--text-muted)] hover:text-[var(--text)]",
            "transition-colors duration-[var(--duration-fast)]",
            "hover:bg-[var(--card)] outline-none",
            "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          )}
        >
          <PencilLine className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>

      {/* Body — workspace section with disclosure caret. Pinned section
          (Settings) sits at the bottom for parity with Linear's lower-rail
          tray (`01-inbox-detail-view.png`). */}
      <div className="flex-1 flex flex-col px-2 py-3 gap-3 overflow-y-auto">
        <section aria-label="Workspace">
          <button
            type="button"
            data-testid="sidebar-section-workspace"
            onClick={() => setWorkspaceOpen((v) => !v)}
            className={cn(
              "flex items-center gap-1 w-full px-2 h-6 rounded-[var(--radius-sm)]",
              "text-[11px] font-medium uppercase tracking-wide",
              "text-[var(--text-subtle)] hover:text-[var(--text-muted)]",
              "transition-colors duration-[var(--duration-fast)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            )}
            aria-expanded={workspaceOpen}
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform duration-[var(--duration-fast)]",
                workspaceOpen ? "rotate-0" : "-rotate-90",
              )}
              aria-hidden
            />
            <span>Workspace</span>
          </button>

          {workspaceOpen ? (
            <div className="mt-1 flex flex-col gap-px">
              {WORKSPACE_NAV.map((item) => (
                <SidebarItem
                  key={item.id}
                  item={item}
                  selected={item.id === route}
                  onSelect={() => setRoute(item.id)}
                  onKeyDownActivate={onItemKeyDown}
                />
              ))}
            </div>
          ) : null}
        </section>
      </div>

      {/* Pinned tray. */}
      <footer className="px-2 py-2 border-t border-[var(--border-subtle)]">
        <div className="flex flex-col gap-px">
          {PINNED_NAV.map((item) => (
            <SidebarItem
              key={item.id}
              item={item}
              selected={item.id === route}
              onSelect={() => setRoute(item.id)}
              onKeyDownActivate={onItemKeyDown}
            />
          ))}
        </div>
      </footer>
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
