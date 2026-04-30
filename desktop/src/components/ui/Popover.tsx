import * as RadixPopover from "@radix-ui/react-popover";
import { type ComponentProps, type ReactNode, forwardRef } from "react";

import { cn } from "@/lib/cn";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;

interface PopoverContentProps
  extends Omit<ComponentProps<typeof RadixPopover.Content>, "children"> {
  children: ReactNode;
}

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, sideOffset = 6, children, ...rest }, ref) => (
    <RadixPopover.Portal>
      <RadixPopover.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)]",
          "shadow-[var(--shadow-2)] p-2 text-sm text-[var(--text)]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        {...rest}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  ),
);
PopoverContent.displayName = "PopoverContent";
