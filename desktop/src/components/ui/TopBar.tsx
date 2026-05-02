import { type ReactNode } from "react";

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
      className={cn(
        "h-14 px-6 shrink-0 flex items-center gap-4",
        "border-b border-[var(--border-subtle)] bg-[var(--bg)]",
        className,
      )}
    >
      <div className="flex flex-col min-w-0 flex-1">
        <h1 className="text-[18px] font-semibold text-[var(--text)] leading-tight truncate">
          {title}
        </h1>
        {meta ? (
          <div className="text-[12px] text-[var(--text-muted)] leading-tight mt-0.5 truncate">
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-1 shrink-0">{actions}</div>
      ) : null}
    </header>
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
