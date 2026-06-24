import * as RadixDialog from "@radix-ui/react-dialog";
import { type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/cn";

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  /**
   * Inline style passed through to `RadixDialog.Content`. Use this when
   * the consumer's layout (e.g. `display: flex`, `max-height`,
   * `overflow`) needs to override the Dialog defaults — `cn()` is a
   * plain concatenator, not `tailwind-merge`, so conflicting Tailwind
   * utilities (`overflow-auto` vs `overflow-hidden`) resolve by CSS
   * source order rather than className order, which is fragile. Inline
   * styles always win the cascade.
   */
  style?: CSSProperties;
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
  style,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn(
            // z-50 so the overlay sits above the chat input bar
            // (`relative z-20` in DockConversation) and any other
            // numbered-z elements in the main shell. Without it,
            // Radix's portaled content has no z-index and gets painted
            // BELOW any positioned sibling with an explicit z value.
            "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        />
        <RadixDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[min(92vw,560px)] max-h-[85vh] overflow-auto",
            "rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg)]",
            "shadow-[var(--shadow-3)] p-5 text-[var(--text)]",
            className,
          )}
          style={style}
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
