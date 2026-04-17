"use client";

/**
 * Shared chrome for replay side panels (Console, Network, and future
 * additions). Handles:
 *   - Collapse state + localStorage persistence (per-panel key)
 *   - Width animation (360px expanded, 40px collapsed tab)
 *   - Header with title, optional actions slot, collapse chevron
 *
 * Each panel owns its body — this component is layout-only.
 *
 * Layout contract: the panel's PARENT must be a flex container that
 * allows the 360px shell to coexist with the rrweb viewport. The viewport
 * listens to its container's `clientWidth` via ResizeObserver and
 * recomputes rrweb's scale when this shell expands/collapses — so the
 * replay scales smoothly without jank.
 */

import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface PanelShellProps {
  /** Visible title in the header. */
  title: string;
  /** Stable key for localStorage. e.g. `iw.replay.panel.console.collapsed`. */
  persistKey: string;
  /** Body content — list, tabs, whatever the panel renders. */
  children: React.ReactNode;
  /** Optional header-right slot (filter select, clear button, etc.). */
  headerActions?: React.ReactNode;
  /** Start collapsed? localStorage overrides this on mount. */
  defaultCollapsed?: boolean;
}

const EXPANDED_WIDTH = 360;
const COLLAPSED_WIDTH = 40;

export function PanelShell({
  title,
  persistKey,
  children,
  headerActions,
  defaultCollapsed = false,
}: PanelShellProps) {
  // Start with the prop default; hydrate from localStorage in an effect so
  // SSR renders deterministically (no hydration mismatch).
  // `hydrated` is state (not a ref) to avoid a write/read race on the
  // first commit — see side-panels.tsx for the same pattern.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(persistKey) : null;
    if (stored === "1") setCollapsed(true);
    else if (stored === "0") setCollapsed(false);
    setHydrated(true);
  }, [persistKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(persistKey, collapsed ? "1" : "0");
    } catch {
      // Private browsing / quota exhausted — silently ignore.
    }
  }, [collapsed, persistKey, hydrated]);

  return (
    <aside
      className="relative shrink-0 border-l border-line bg-surface transition-[width] duration-150 ease-out"
      style={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      aria-label={title}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="group flex h-full w-full flex-col items-center justify-start gap-3 py-4 text-fg-base/70 transition-colors hover:text-fg-strong"
          aria-label={`Expand ${title} panel`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          <span
            className="text-xs font-medium tracking-wider uppercase"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            {title}
          </span>
        </button>
      ) : (
        <div className="flex h-full flex-col">
          <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-strong truncate">
                {title}
              </h2>
              {headerActions}
            </div>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="shrink-0 rounded p-0.5 text-fg-base/60 transition-colors hover:bg-surface-inner hover:text-fg-strong"
              aria-label={`Collapse ${title} panel`}
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
        </div>
      )}
    </aside>
  );
}
