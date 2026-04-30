import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-[var(--color-primary)] text-white hover:brightness-110 active:brightness-95",
  secondary:
    "bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--color-border)]",
  ghost:
    "bg-transparent text-[var(--text)] hover:bg-[var(--surface)]",
  danger:
    "bg-[var(--color-danger)] text-white hover:brightness-110 active:brightness-95",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs rounded-[var(--radius-sm)]",
  md: "h-9 px-3.5 text-sm rounded-[var(--radius-md)]",
  lg: "h-11 px-5 text-base rounded-[var(--radius-lg)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium",
        "transition-[transform,background-color,filter] duration-[var(--duration-fast)]",
        "ease-[var(--easing-out)] hover:scale-[1.02] active:scale-[0.97]",
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
