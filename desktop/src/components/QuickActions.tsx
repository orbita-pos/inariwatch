import { motion, useReducedMotion } from "framer-motion";
import { FileSearch, MessageSquare, Wrench, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

export type QuickActionKind = "chat" | "search" | "fix";

interface QuickActionDescriptor {
  kind: QuickActionKind;
  label: string;
  hint: string;
  icon: LucideIcon;
}

const ACTIONS: QuickActionDescriptor[] = [
  {
    kind: "chat",
    label: "Chat with Inari",
    hint: "Ask anything about this repo",
    icon: MessageSquare,
  },
  {
    kind: "search",
    label: "Search code",
    hint: "Semantic search across the indexed repo",
    icon: FileSearch,
  },
  {
    kind: "fix",
    label: "Fix recent",
    hint: "Run a remediation pass on the latest alert",
    icon: Wrench,
  },
];

interface QuickActionsProps {
  onSelect: (kind: QuickActionKind) => void;
}

/**
 * Three-up grid of high-intent actions. Hover scales 1.02 with a Framer
 * spring, reduced-motion users see no transform. Tokens come from the
 * design-system OKLCH palette — no raw colors.
 */
export function QuickActions({ onSelect }: QuickActionsProps) {
  const reduce = useReducedMotion();
  return (
    <div
      data-testid="quick-actions"
      className="grid grid-cols-3 gap-3"
    >
      {ACTIONS.map((action) => {
        const Icon = action.icon;
        return (
          <motion.button
            key={action.kind}
            type="button"
            data-testid={`quick-action-${action.kind}`}
            onClick={() => onSelect(action.kind)}
            whileHover={reduce ? undefined : { scale: 1.02 }}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 360, damping: 26 }
            }
            className={cn(
              "flex flex-col items-start gap-1 p-3 text-left",
              "rounded-[var(--radius-lg)] border border-[var(--border)]",
              "bg-[var(--surface)] text-[var(--text)]",
              "hover:border-[var(--color-primary)]",
              "transition-colors duration-[var(--duration-fast)]",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]",
            )}
          >
            <Icon className="h-4 w-4 text-[var(--color-ai)]" aria-hidden />
            <span className="text-sm font-medium leading-tight">{action.label}</span>
            <span className="text-xs text-[var(--muted)] leading-snug">
              {action.hint}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
