import { forwardRef } from "react";

import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "data-testid"?: string;
  className?: string;
}

/**
 * Minimal switch primitive. Built locally instead of pulling in
 * `@radix-ui/react-switch` (one extra dep) — see Sesión-17 DECISIONS
 * "Custom switch primitive" for rationale.
 *
 * Renders a `<button role="switch">` with `aria-checked` and a thumb
 * that translates on state. Keyboard accessible via space/enter (browser
 * default for `<button>`).
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onCheckedChange(!checked);
      }}
      className={cn(
        "relative w-9 h-5 rounded-full bg-[var(--border)] transition-colors",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        "data-[state=checked]:bg-[var(--accent)]",
        disabled && "opacity-50 pointer-events-none",
        className,
      )}
      {...rest}
    >
      <span
        className={cn(
          "block w-4 h-4 rounded-full bg-white shadow-sm transition-transform",
          "absolute top-0.5",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  ),
);
Switch.displayName = "Switch";
