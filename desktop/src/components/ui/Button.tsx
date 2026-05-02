import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/**
 * Button — S33 (2026-05-01) restyle.
 *
 * Hover model is bg/opacity-only (NO scale, NO shadow shift) per the Linear
 * design language documented in `specs/linear-ux-reference/README.md`
 * § Anti-patterns. Active state darkens the bg further; disabled drops
 * to 50% opacity with pointer-events suppressed.
 *
 * Variants:
 *   - `primary` — burnt orange (`#ea580c`). Hero CTAs, the only confidently
 *     accent surface in any given screen.
 *   - `secondary` — neutral surface with border. The default for low-emphasis
 *     actions inside cards/forms.
 *   - `ghost` — transparent until hover. For inline / dense rows.
 *   - `danger` — red. Confirm-destructive only.
 */
const VARIANT_CLASSES: Record<Variant, string> = {
  primary: cn(
    "bg-[var(--accent)] text-white border border-[var(--accent)]",
    "hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]",
    "active:bg-[var(--accent-hover)] active:brightness-95",
  ),
  secondary: cn(
    "bg-[var(--card)] text-[var(--text)] border border-[var(--border)]",
    "hover:bg-[var(--card-elevated)] hover:border-[var(--border-strong)]",
    "active:bg-[var(--card-elevated)]",
  ),
  ghost: cn(
    "bg-transparent text-[var(--text-muted)] border border-transparent",
    "hover:bg-[var(--card)] hover:text-[var(--text)]",
    "active:bg-[var(--card-elevated)]",
  ),
  danger: cn(
    "bg-[var(--danger)] text-white border border-[var(--danger)]",
    "hover:brightness-110",
    "active:brightness-95",
  ),
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] rounded-[var(--radius-sm)]",
  md: "h-8 px-3 text-[13px] rounded-[var(--radius-sm)]",
  lg: "h-10 px-4 text-[14px] rounded-[var(--radius-md)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium cursor-pointer",
        "transition-colors duration-[var(--duration-fast)] ease-[var(--easing-out)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
        "disabled:opacity-50 disabled:pointer-events-none",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    />
  ),
);
Button.displayName = "Button";
