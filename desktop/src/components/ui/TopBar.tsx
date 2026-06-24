import { type ReactNode } from "react";
import { Minus, Square, X } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * Linear-style top bar primitive (S33). Sits above each main screen's
 * scroll area. Three slots:
 *   - `title` — left-aligned, 18-24px peso 600 (matches Linear's
 *     `01-inbox-detail-view.png` `App freezes on splash screen` header).
 *   - `meta` — small muted line directly under the title (counts, breadcrumbs).
 *   - `actions` — right-aligned action squares (28×28). Use <ActionSquare>
 *     to keep hover/focus states consistent.
 *
 * No drop shadow, no gradient bg — only an ultra-subtle bottom border so
 * the dense list/feed below reads as continuous with the bar.
 */
export interface TopBarProps {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Optional `data-testid` to anchor screen-level tests. */
  testId?: string;
}

export function TopBar({ title, meta, actions, className, testId }: TopBarProps) {
  return (
    <header
      data-testid={testId}
      // The whole top bar (except interactive controls) is a window drag
      // region — `data-tauri-drag-region` makes it grabbable like a native
      // title bar. Buttons / inputs inside override via their own pointer
      // handlers; clicks pass through to drag only on the empty surface.
      data-tauri-drag-region
      className={cn(
        "h-14 px-6 shrink-0 flex items-center gap-4",
        "border-b border-[var(--border-subtle)] bg-[var(--bg)]",
        className,
      )}
    >
      <div className="flex flex-col min-w-0 flex-1" data-tauri-drag-region>
        <h1
          data-tauri-drag-region
          className="text-[18px] font-semibold text-[var(--text)] leading-tight truncate"
        >
          {title}
        </h1>
        {meta ? (
          <div
            data-tauri-drag-region
            className="text-[12px] text-[var(--text-muted)] leading-tight mt-0.5 truncate"
          >
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-1 shrink-0">{actions}</div>
      ) : null}
      <WindowControls />
    </header>
  );
}

/**
 * Right-edge minimise / maximise / close trio. Renders only inside a
 * Tauri webview (the dynamic import resolves to a no-op when running
 * under jsdom or a plain browser). Visually integrated into the top
 * bar instead of a separate title bar so the chrome stays minimal.
 *
 * Close uses .close() (graceful — fires the on_window_event hook in
 * lib.rs which hides-to-tray instead of quitting). Minimise/maximise
 * call the corresponding Tauri APIs directly.
 */
function WindowControls() {
  async function call(action: "minimize" | "toggleMaximize" | "close") {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      if (action === "minimize") await w.minimize();
      else if (action === "toggleMaximize") await w.toggleMaximize();
      else await w.close();
    } catch {
      // Not running under Tauri (jsdom test, plain browser preview) — skip.
    }
  }

  return (
    <div className="flex items-center gap-1 shrink-0 ml-1">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => call("minimize")}
        className={cn(
          "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
          "text-[var(--text-muted)] hover:text-[var(--text)]",
          "hover:bg-[var(--card)] cursor-pointer",
          "transition-colors duration-[var(--duration-fast)] outline-none",
          "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        )}
      >
        <Minus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => call("toggleMaximize")}
        className={cn(
          "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
          "text-[var(--text-muted)] hover:text-[var(--text)]",
          "hover:bg-[var(--card)] cursor-pointer",
          "transition-colors duration-[var(--duration-fast)] outline-none",
          "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        )}
      >
        <Square className="h-3 w-3" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => call("close")}
        className={cn(
          "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
          "text-[var(--text-muted)] hover:text-white",
          "hover:bg-[var(--danger)] cursor-pointer",
          "transition-colors duration-[var(--duration-fast)] outline-none",
          "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        )}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * 28×28 action square — the standard right-rail icon button shape used in
 * Linear's screenshots (notifications, panel toggle, kebab, etc).
 */
export interface ActionSquareProps {
  onClick?: () => void;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  testId?: string;
  disabled?: boolean;
}

export function ActionSquare({
  onClick,
  ariaLabel,
  children,
  className,
  testId,
  disabled,
}: ActionSquareProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
        "text-[var(--text-muted)] hover:text-[var(--text)]",
        "hover:bg-[var(--card)] cursor-pointer",
        "transition-colors duration-[var(--duration-fast)] outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        "disabled:opacity-50 disabled:pointer-events-none",
        className,
      )}
    >
      {children}
    </button>
  );
}
