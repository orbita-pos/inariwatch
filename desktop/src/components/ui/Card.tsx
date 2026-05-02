import { type HTMLAttributes, forwardRef } from "react";

import { cn } from "@/lib/cn";

/**
 * Card — S33 (2026-05-01). Standard surface used inside main screens.
 *
 * Reference: `specs/linear-ux-reference/03-initiatives-feed.png` cards and
 * `09-agents-insights-charts.png` stat tiles.
 *
 * Tokens: bg `--card`, border `--border`, radius `--radius-lg`, padding-5
 * (= 16px) by default. `elevated` raises onto `--card-elevated` for modals
 * / popovers / "this matters" surfaces.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
  /** Drop the default border — useful when the card is inside a list and
   *  the outer container already supplies separation. */
  borderless?: boolean;
  /** Drop default padding for cards that render their own internal layout. */
  noPadding?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, elevated, borderless, noPadding, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)]",
        elevated ? "bg-[var(--card-elevated)]" : "bg-[var(--card)]",
        !borderless && "border border-[var(--border)]",
        !noPadding && "p-5",
        className,
      )}
      {...rest}
    />
  ),
);
Card.displayName = "Card";
