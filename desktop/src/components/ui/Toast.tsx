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

interface ToastProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  variant?: "default" | "danger";
}

export function Toast({ open, onOpenChange, title, description, variant = "default" }: ToastProps) {
  return (
    <RadixToast.Root
      open={open}
      onOpenChange={onOpenChange}
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)]",
        "shadow-[var(--shadow-2)] p-3 text-sm text-[var(--text)]",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-4",
        variant === "danger" && "border-[var(--color-danger)]",
      )}
    >
      <RadixToast.Title className="font-semibold">{title}</RadixToast.Title>
      {description ? (
        <RadixToast.Description className="text-[var(--muted)] mt-0.5">
          {description}
        </RadixToast.Description>
      ) : null}
    </RadixToast.Root>
  );
}
