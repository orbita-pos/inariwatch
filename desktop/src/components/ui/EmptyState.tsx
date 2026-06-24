import { type ComponentType, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * EmptyState — S33 (2026-05-01). Standard pattern for "this list is empty
 * and that's okay" surfaces. Per CLAUDE.md the spec calls for at least 5
 * empty-state covered surfaces (alerts, repos, memory, search, history).
 *
 * Anatomy:
 *   - Icon at 48px in `--text-subtle` (low-contrast, doesn't compete with copy)
 *   - Headline at 15px in `--text` (the "what" of the empty state)
 *   - Helper at 13px in `--text-muted` (the "why" / next step)
 *   - Optional CTA slot, typically a primary <Button> with `--accent` bg
 */
export interface EmptyStateProps {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  headline: ReactNode;
  helper?: ReactNode;
  cta?: ReactNode;
  className?: string;
  testId?: string;
}

export function EmptyState({
  icon: Icon,
  headline,
  helper,
  cta,
  className,
  testId,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      role="status"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        "py-12 px-6 gap-3",
        className,
      )}
    >
      {Icon ? (
        <Icon
          className="h-12 w-12 text-[var(--text-subtle)] mb-1"
          aria-hidden
        />
      ) : null}
      <h2 className="text-[15px] font-semibold text-[var(--text)] leading-tight">
        {headline}
      </h2>
      {helper ? (
        <p className="text-[13px] text-[var(--text-muted)] leading-relaxed max-w-md">
          {helper}
        </p>
      ) : null}
      {cta ? <div className="mt-2">{cta}</div> : null}
    </div>
  );
}
