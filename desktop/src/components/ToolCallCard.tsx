import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Wrench } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import type { ToolCall } from "@/lib/store/chat";

interface ToolCallCardProps {
  toolCall: ToolCall;
}

function pretty(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Inline card for an assistant tool call. Collapsed by default; the
 * caret rotates 90° on expand and the body slides in via Framer's
 * `layout` animation. Reduced-motion drops the spring + rotation
 * tween in favour of an instant swap.
 */
export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();

  return (
    <motion.div
      layout={reduce ? false : "size"}
      transition={
        reduce
          ? { duration: 0 }
          : { type: "spring", stiffness: 320, damping: 28 }
      }
      data-testid="tool-call-card"
      data-open={open ? "true" : "false"}
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--border)]",
        "bg-[var(--surface)] overflow-hidden",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center gap-2 px-2.5 py-1.5",
          "text-left text-xs font-[var(--font-mono)] text-[var(--text)]",
          "hover:bg-[var(--bg)] transition-colors duration-[var(--duration-fast)]",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-primary)]",
        )}
      >
        <Wrench className="h-3 w-3 text-[var(--color-ai)]" aria-hidden />
        <span className="flex-1 truncate">{toolCall.name}</span>
        <motion.span
          aria-hidden
          animate={reduce ? undefined : { rotate: open ? 0 : -90 }}
          transition={{ duration: 0.15 }}
          className="text-[var(--muted)]"
        >
          <ChevronDown className="h-3 w-3" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={
              reduce ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }
            }
            className="border-t border-[var(--border)]"
            data-testid="tool-call-body"
          >
            <div className="p-2.5 space-y-2 text-[0.7rem]">
              <div>
                <span className="block text-[var(--muted)] uppercase tracking-wider mb-0.5">
                  input
                </span>
                <pre className="m-0 p-2 rounded-[var(--radius-sm)] bg-[var(--bg)] border border-[var(--border)] overflow-auto font-[var(--font-mono)] text-[var(--text)]">
                  {pretty(toolCall.input)}
                </pre>
              </div>
              <div>
                <span className="block text-[var(--muted)] uppercase tracking-wider mb-0.5">
                  output
                </span>
                <pre className="m-0 p-2 rounded-[var(--radius-sm)] bg-[var(--bg)] border border-[var(--border)] overflow-auto font-[var(--font-mono)] text-[var(--text)]">
                  {pretty(toolCall.output)}
                </pre>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
