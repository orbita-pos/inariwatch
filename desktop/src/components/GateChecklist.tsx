import { motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, Circle, MinusCircle, XCircle } from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "@/lib/cn";
import type { GateResult, GateStatus } from "@/types/alert";

interface GateChecklistProps {
  gates: GateResult[];
  /** Stagger between item reveals, in ms. Defaults to 50 (Linear-style). */
  staggerMs?: number;
}

interface GateRowVisuals {
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  toneClass: string;
  label: string;
}

const STATUS_VISUALS: Record<GateStatus, GateRowVisuals> = {
  pass: {
    Icon: CheckCircle2,
    toneClass: "text-[var(--color-success)]",
    label: "passed",
  },
  fail: {
    Icon: XCircle,
    toneClass: "text-[var(--color-danger)]",
    label: "failed",
  },
  pending: {
    Icon: Circle,
    toneClass: "text-[var(--muted)]",
    label: "pending",
  },
  skipped: {
    Icon: MinusCircle,
    toneClass: "text-[var(--muted)] opacity-60",
    label: "not applicable",
  },
};

function humanizeGateName(name: string): string {
  return name.replace(/_/g, " ");
}

/**
 * Vertical 17-gate checklist with a Linear-style stagger reveal (50ms
 * between rows). Each row shows the status icon, human-readable name,
 * and an optional `detail` line for failed gates.
 *
 * Reduced-motion users get every row visible immediately; the `data-
 * stagger="off"` attribute is the test hook for verifying that path.
 */
export function GateChecklist({ gates, staggerMs = 50 }: GateChecklistProps) {
  const reduce = useReducedMotion();
  const staggerSec = staggerMs / 1000;

  const containerVariants = {
    hidden: { opacity: 1 },
    visible: {
      opacity: 1,
      transition: reduce
        ? { staggerChildren: 0 }
        : { staggerChildren: staggerSec },
    },
  };
  const itemVariants = {
    hidden: reduce ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 },
    visible: {
      opacity: 1,
      y: 0,
      transition: reduce ? { duration: 0 } : { duration: 0.2, ease: "easeOut" },
    },
  };

  return (
    <motion.ul
      data-testid="gate-checklist"
      data-stagger={reduce ? "off" : "on"}
      data-gate-count={gates.length}
      className="flex flex-col gap-1"
      initial="hidden"
      animate="visible"
      variants={containerVariants}
    >
      {gates.map((gate) => {
        const visuals = STATUS_VISUALS[gate.status];
        const { Icon } = visuals;
        return (
          <motion.li
            key={gate.id}
            data-testid="gate-row"
            data-gate-id={gate.id}
            data-gate-status={gate.status}
            variants={itemVariants}
            className={cn(
              "flex items-start gap-2 px-2 py-1",
              "rounded-[var(--radius-sm)] text-xs",
              "font-[var(--font-mono)] text-[var(--text)]",
            )}
          >
            <Icon
              className={cn("h-3.5 w-3.5 shrink-0 mt-[1px]", visuals.toneClass)}
              aria-hidden
            />
            <div className="flex flex-col flex-1 min-w-0">
              <span className="truncate">
                <span className="text-[var(--muted)] mr-1">{gate.id}</span>
                {humanizeGateName(gate.name)}
                <span className="sr-only"> — {visuals.label}</span>
              </span>
              {gate.status === "fail" && gate.detail ? (
                <span
                  className="text-[var(--color-danger)] text-[0.7rem] truncate"
                  data-testid="gate-row-detail"
                >
                  {gate.detail}
                </span>
              ) : null}
            </div>
          </motion.li>
        );
      })}
    </motion.ul>
  );
}
