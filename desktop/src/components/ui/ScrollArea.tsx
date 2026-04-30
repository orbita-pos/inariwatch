import * as RadixScrollArea from "@radix-ui/react-scroll-area";
import { type ComponentProps, forwardRef } from "react";

import { cn } from "@/lib/cn";

interface ScrollAreaProps extends ComponentProps<typeof RadixScrollArea.Root> {
  viewportClassName?: string;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, viewportClassName, children, ...rest }, ref) => (
    <RadixScrollArea.Root
      ref={ref}
      className={cn("relative overflow-hidden", className)}
      {...rest}
    >
      <RadixScrollArea.Viewport
        className={cn("h-full w-full rounded-[inherit]", viewportClassName)}
      >
        {children}
      </RadixScrollArea.Viewport>
      <RadixScrollArea.Scrollbar
        orientation="vertical"
        className="flex select-none touch-none p-0.5 bg-transparent w-2"
      >
        <RadixScrollArea.Thumb className="flex-1 rounded-full bg-[var(--border)] hover:bg-[var(--muted)]" />
      </RadixScrollArea.Scrollbar>
      <RadixScrollArea.Corner />
    </RadixScrollArea.Root>
  ),
);
ScrollArea.displayName = "ScrollArea";
