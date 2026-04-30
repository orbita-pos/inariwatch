import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-[var(--radius-md)] px-3 text-sm",
        "bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]",
        "placeholder:text-[var(--muted)]",
        "transition-colors duration-[var(--duration-fast)]",
        "focus:outline-none focus:border-[var(--color-primary)]",
        "disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = "Input";
