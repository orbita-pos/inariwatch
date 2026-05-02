import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * Input — S33 (2026-05-01). Linear-density: 32px tall, 13px text, subtle
 * border that ramps to `--accent` on focus (NOT a heavy ring).
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full rounded-[var(--radius-sm)] px-3 text-[13px]",
        "bg-[var(--card)] text-[var(--text)]",
        "border border-[var(--border)]",
        "placeholder:text-[var(--text-subtle)]",
        "transition-colors duration-[var(--duration-fast)]",
        "hover:border-[var(--border-strong)]",
        "focus:outline-none focus:border-[var(--accent)]",
        "focus:ring-1 focus:ring-[var(--accent)] focus:ring-offset-0",
        "disabled:opacity-50 disabled:pointer-events-none",
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = "Input";
