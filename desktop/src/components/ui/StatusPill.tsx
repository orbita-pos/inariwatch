import { type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * StatusPill — S33 (2026-05-01). Linear-style colored-dot + label pill,
 * used everywhere a row needs to communicate status at a glance.
 *
 * Reference: `specs/linear-ux-reference/04-initiatives-active-table.png`
 * (`● On track` / `● At risk` / `● Off track`) and
 * `01-inbox-detail-view.png` Triage Intelligence (`● emil`, `● iOS`, `● Bug`).
 *
 * Variants map to the LOCKED status palette from `globals.css`:
 *   - success → green
 *   - warning → amber
 *   - danger  → red
 *   - accent  → burnt orange (the InariWatch brand — replaces Linear's purple)
 *   - neutral → gray (categories with no semantic color)
 */
export type StatusPillVariant =
  | "success"
  | "warning"
  | "danger"
  | "accent"
  | "neutral";

export interface StatusPillProps {
  variant?: StatusPillVariant;
  children: ReactNode;
  className?: string;
  /** Drop the leading dot — useful for category pills (Reliability, Bug…). */
  noDot?: boolean;
  testId?: string;
}

const VARIANT_STYLES: Record<
  StatusPillVariant,
  { dot: string; bg: string; text: string }
> = {
  success: {
    dot:  "bg-[var(--success)]",
    bg:   "bg-[rgb(76_183_130_/_0.10)]",
    text: "text-[var(--success)]",
  },
  warning: {
    dot:  "bg-[var(--warning)]",
    bg:   "bg-[rgb(240_160_32_/_0.10)]",
    text: "text-[var(--warning)]",
  },
  danger: {
    dot:  "bg-[var(--danger)]",
    bg:   "bg-[rgb(235_87_87_/_0.10)]",
    text: "text-[var(--danger)]",
  },
  accent: {
    dot:  "bg-[var(--accent)]",
    bg:   "bg-[rgb(234_88_12_/_0.10)]",
    text: "text-[var(--accent-light)]",
  },
  neutral: {
    dot:  "bg-[var(--text-subtle)]",
    bg:   "bg-[var(--card)]",
    text: "text-[var(--text-muted)]",
  },
};

export function StatusPill({
  variant = "neutral",
  children,
  className,
  noDot,
  testId,
}: StatusPillProps) {
  const styles = VARIANT_STYLES[variant];
  return (
    <span
      data-testid={testId}
      data-variant={variant}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-sm)]",
        "text-[11px] font-medium leading-[1.4] whitespace-nowrap",
        styles.bg,
        styles.text,
        className,
      )}
    >
      {!noDot ? (
        <span
          aria-hidden
          className={cn("w-1.5 h-1.5 rounded-full shrink-0", styles.dot)}
        />
      ) : null}
      {children}
    </span>
  );
}
