import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

interface KbdHintProps {
  children: ReactNode;
  className?: string;
}

/** Render a keyboard shortcut as discrete `<kbd>` chips. Children can be a
 * string ("⌘K") or a fragment of preformatted nodes. Strings are split on
 * whitespace so each token gets its own visual chip. */
export function KbdHint({ children, className }: KbdHintProps) {
  if (typeof children !== "string") {
    return <span className={cn("inline-flex gap-1", className)}>{children}</span>;
  }
  const tokens = children.split(/\s+/u).filter(Boolean);
  return (
    <span className={cn("inline-flex gap-1", className)}>
      {tokens.map((t, i) => (
        <kbd
          key={`${t}-${i}`}
          className={cn(
            "inline-flex items-center justify-center min-w-[1.5em] h-[1.5em]",
            "rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)]",
            "px-1 text-[0.72rem] font-medium text-[var(--muted)]",
            "font-[var(--font-mono)]",
          )}
        >
          {t}
        </kbd>
      ))}
    </span>
  );
}
