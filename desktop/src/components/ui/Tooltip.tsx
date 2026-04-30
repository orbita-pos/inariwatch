import * as RadixTooltip from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";

import { cn } from "@/lib/cn";

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={250}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({ label, children, side = "top", delayDuration }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 px-2 py-1 rounded-[var(--radius-sm)]",
            "bg-[var(--text)] text-[var(--bg)] text-xs font-medium",
            "shadow-[var(--shadow-2)]",
          )}
        >
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
