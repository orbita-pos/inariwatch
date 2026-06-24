import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";

interface ConfidenceBadgeProps {
  /** Target value 0–100. Counter animates 0 → value over 600ms. */
  value: number;
  /** When true, runs the counter animation again on `value` change. */
  animateOnChange?: boolean;
  className?: string;
}

function classifyConfidence(value: number): "high" | "med" | "low" {
  if (value >= 80) return "high";
  if (value >= 60) return "med";
  return "low";
}

const TONE_CLASSES: Record<"high" | "med" | "low", string> = {
  high: "text-[var(--color-success)] border-[var(--color-success)]",
  med: "text-[var(--color-warning)] border-[var(--color-warning)]",
  low: "text-[var(--color-danger)] border-[var(--color-danger)]",
};

/**
 * Confidence badge — counter animates 0 → value over 600ms via Framer's
 * `useMotionValue`. Reduced-motion users get the final value instantly.
 *
 * Tone (success / warning / danger) is keyed off `classifyConfidence`,
 * never raw red/green/yellow tokens — the OKLCH palette is the SSOT.
 */
export function ConfidenceBadge({
  value,
  animateOnChange = true,
  className,
}: ConfidenceBadgeProps) {
  const reduce = useReducedMotion();
  const motionValue = useMotionValue(reduce ? value : 0);
  const rounded = useTransform(motionValue, (v) => Math.round(v));
  const [display, setDisplay] = useState(reduce ? Math.round(value) : 0);

  useEffect(() => {
    if (reduce) {
      motionValue.set(value);
      setDisplay(Math.round(value));
      return;
    }

    if (!animateOnChange) {
      motionValue.set(value);
      setDisplay(Math.round(value));
      return;
    }

    const controls = animate(motionValue, value, {
      duration: 0.6,
      ease: "easeOut",
    });
    const unsubscribe = rounded.on("change", (v) => setDisplay(v));
    return () => {
      controls.stop();
      unsubscribe();
    };
    // motionValue / rounded are stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce, animateOnChange]);

  const tone = classifyConfidence(value);

  return (
    <motion.span
      data-testid="confidence-badge"
      data-confidence-tone={tone}
      data-confidence-value={value}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5",
        "rounded-[var(--radius-sm)] border bg-[var(--surface)]",
        "text-xs font-[var(--font-mono)]",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span aria-hidden>★</span>
      <span data-testid="confidence-badge-value">{display}</span>
      <span className="text-[var(--muted)]">/100</span>
    </motion.span>
  );
}
