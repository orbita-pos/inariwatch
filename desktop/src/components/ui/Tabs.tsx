import * as RadixTabs from "@radix-ui/react-tabs";
import { type ComponentProps, forwardRef } from "react";

import { cn } from "@/lib/cn";

export const Tabs = RadixTabs.Root;

/**
 * Tabs — S33 (2026-05-01) restyle. Minimal Linear-style tabs:
 *   - TabsList: row with bottom border, no bg pill
 *   - TabsTrigger: 13-15px label, active state = bottom-border 2px accent
 *     (NOT a filled pill, NOT purple — burnt orange #ea580c)
 *
 * Reference: `specs/linear-ux-reference/04-initiatives-active-table.png` and
 * `08-agent-tasks-kanban-alt.png` top-of-page tab rows.
 */
export const TabsList = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof RadixTabs.List>
>(({ className, ...rest }, ref) => (
  <RadixTabs.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-3 border-b border-[var(--border)]",
      className,
    )}
    {...rest}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof RadixTabs.Trigger>
>(({ className, ...rest }, ref) => (
  <RadixTabs.Trigger
    ref={ref}
    className={cn(
      "relative inline-flex items-center justify-center px-1 h-9",
      "text-[13px] font-medium cursor-pointer",
      "text-[var(--text-muted)] hover:text-[var(--text)]",
      // 2px bottom strip — transparent by default, accent when active.
      // The strip lives at -1px so it overlaps the parent border-bottom
      // and reads as a clean underline rather than a separate row.
      "after:content-[''] after:absolute after:left-0 after:right-0 after:-bottom-px",
      "after:h-[2px] after:bg-transparent after:rounded-full",
      "data-[state=active]:text-[var(--text)]",
      "data-[state=active]:after:bg-[var(--accent)]",
      "transition-colors duration-[var(--duration-fast)]",
      "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-0",
      className,
    )}
    {...rest}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof RadixTabs.Content>
>(({ className, ...rest }, ref) => (
  <RadixTabs.Content ref={ref} className={cn("pt-4", className)} {...rest} />
));
TabsContent.displayName = "TabsContent";
