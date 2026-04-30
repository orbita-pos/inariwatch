import * as RadixTabs from "@radix-ui/react-tabs";
import { type ComponentProps, forwardRef } from "react";

import { cn } from "@/lib/cn";

export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef<HTMLDivElement, ComponentProps<typeof RadixTabs.List>>(
  ({ className, ...rest }, ref) => (
    <RadixTabs.List
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--surface)]",
        className,
      )}
      {...rest}
    />
  ),
);
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof RadixTabs.Trigger>
>(({ className, ...rest }, ref) => (
  <RadixTabs.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center px-3 h-7 text-sm font-medium",
      "rounded-[var(--radius-sm)] text-[var(--muted)]",
      "data-[state=active]:bg-[var(--bg)] data-[state=active]:text-[var(--text)]",
      "data-[state=active]:shadow-[var(--shadow-1)]",
      "transition-colors duration-[var(--duration-fast)]",
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
  <RadixTabs.Content ref={ref} className={cn("pt-3", className)} {...rest} />
));
TabsContent.displayName = "TabsContent";
