import * as RadixDialog from "@radix-ui/react-dialog";
import { type ReactNode } from "react";

import { cn } from "@/lib/cn";

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Thin Radix Dialog wrapper. The radix primitives are kept as-is so consumers
 * can drop into them directly when they need finer control (e.g. portaled
 * footers); this wrapper gives the common case a one-liner.
 */
export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn(
            "fixed inset-0 bg-black/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        />
        <RadixDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
            "w-[min(92vw,560px)] max-h-[85vh] overflow-auto",
            "rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg)]",
            "shadow-[var(--shadow-3)] p-5 text-[var(--text)]",
            className,
          )}
        >
          {title ? (
            <RadixDialog.Title className="text-base font-semibold mb-1">{title}</RadixDialog.Title>
          ) : null}
          {description ? (
            <RadixDialog.Description className="text-sm text-[var(--muted)] mb-4">
              {description}
            </RadixDialog.Description>
          ) : null}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
