import * as RadixToast from "@radix-ui/react-toast";
import { type ReactNode } from "react";

import { cn } from "@/lib/cn";

export const ToastProvider = RadixToast.Provider;

export const ToastViewport = ({ className }: { className?: string }) => (
  <RadixToast.Viewport
    className={cn(
      "fixed bottom-0 right-0 z-[100] m-4 flex w-[360px] max-w-[100vw] flex-col gap-2",
      className,
    )}
  />
);

type ToastVariant = "default" | "success" | "warning" | "danger" | "accent";

interface ToastProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  variant?: ToastVariant;
}

/**
 * Toast — S33 (2026-05-01). Linear-style: border-left 2px in the status
 * color, soft shadow, slide-up + fade entry, slide-down + fade exit.
 *
 * Variants map onto the LOCKED status palette (`globals.css`):
 *   - default → no accent strip (neutral message)
 *   - success → green strip
 *   - warning → amber strip
 *   - danger  → red strip
 *   - accent  → burnt orange (brand-emphasized notice)
 */
const VARIANT_BORDER: Record<ToastVariant, string> = {
  default: "border-l-transparent",
  success: "border-l-[var(--success)]",
  warning: "border-l-[var(--warning)]",
  danger:  "border-l-[var(--danger)]",
  accent:  "border-l-[var(--accent)]",
};

export function Toast({
  open,
  onOpenChange,
  title,
  description,
  variant = "default",
}: ToastProps) {
  return (
    <RadixToast.Root
      open={open}
      onOpenChange={onOpenChange}
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--card-elevated)]",
        // 2px status strip on the left edge — overrides the base `border` width.
        "border-l-2",
        VARIANT_BORDER[variant],
        "shadow-[var(--shadow-2)] px-4 py-3 text-[13px] text-[var(--text)]",
        // Radix data-state animations — slide up + fade in, slide down + fade out.
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-bottom-2",
        "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
        "data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-[transform_200ms_ease-out]",
        "data-[swipe=end]:animate-out data-[swipe=end]:fade-out-80 data-[swipe=end]:slide-out-to-right-full",
      )}
    >
      <RadixToast.Title className="font-semibold leading-tight">
        {title}
      </RadixToast.Title>
      {description ? (
        <RadixToast.Description className="text-[12px] text-[var(--text-muted)] mt-1 leading-relaxed">
          {description}
        </RadixToast.Description>
      ) : null}
    </RadixToast.Root>
  );
}
