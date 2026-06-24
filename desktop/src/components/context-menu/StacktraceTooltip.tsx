import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import type { StacktraceLocation } from "@/lib/stacktrace";
import { desktopToolConfirm } from "@/lib/tool-invoke-ipc";

export interface StacktraceTooltipProps {
  /** Parsed location underlying the wrapped span. */
  location: StacktraceLocation;
  /** Hover delay in milliseconds before the tooltip mounts. */
  delayMs?: number;
  /** Test seam — defaults to the real `desktop_tool_confirm`. */
  invokeConfirm?: typeof desktopToolConfirm;
  /** Test seam — defaults to `navigator.clipboard.writeText`. */
  copyToClipboard?: (text: string) => Promise<void>;
  testId?: string;
  children: React.ReactNode;
}

/**
 * Hover-after-`delayMs` tooltip that surfaces the matched location +
 * two action buttons (Open in Editor / Copy path). Snippet preview
 * (showing the actual file lines around the match) is intentionally
 * NOT included in S7 — it would require a `local.read_file` IPC
 * round-trip per hover, and the path may not exist on disk for
 * cloud-only paths. S7.5 can add a snippet slot if the tooltip ends
 * up being heavily used in dogfood.
 *
 * Position: anchored above the trigger by default; flips below when
 * the trigger sits in the top quarter of the viewport.
 */
export function StacktraceTooltip({
  location,
  delayMs = 250,
  invokeConfirm = desktopToolConfirm,
  copyToClipboard,
  testId,
  children,
}: StacktraceTooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, placeAbove: true });

  const compute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const placeAbove = rect.top > 120;
    setPos({
      x: Math.round(rect.left),
      y: placeAbove ? Math.round(rect.top - 8) : Math.round(rect.bottom + 8),
      placeAbove,
    });
  }, []);

  const onEnter = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      compute();
      setOpen(true);
    }, delayMs);
  }, [compute, delayMs]);

  const onLeave = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setOpen(false);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Dismiss on Esc + scroll + blur (matches ContextMenu behaviour).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    const onBlur = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const onOpenInEditor = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await invokeConfirm(
          "desktop.open_in_editor",
          { path: location.file, line: location.line },
          "ambient-hover",
        );
      } catch (err) {
        console.warn("[stacktrace] open_in_editor failed", err);
      }
      setOpen(false);
    },
    [invokeConfirm, location],
  );

  const onCopyPath = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const writer =
        copyToClipboard ??
        (async (text: string) => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(text);
          }
        });
      try {
        await writer(location.file);
      } catch (err) {
        console.warn("[stacktrace] copy path failed", err);
      }
      setOpen(false);
    },
    [copyToClipboard, location.file],
  );

  const locationLabel = `${location.file}:${location.line}${location.col ? `:${location.col}` : ""}`;

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        data-testid={testId}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <div
              role="tooltip"
              data-testid={testId ? `${testId}-tooltip` : undefined}
              style={{
                position: "fixed",
                left: pos.x,
                top: pos.y,
                transform: pos.placeAbove ? "translateY(-100%)" : undefined,
                zIndex: 9998,
              }}
              className={cn(
                "min-w-[260px] max-w-[360px]",
                "rounded-[var(--radius-md)] border border-[var(--border)]",
                "bg-[var(--card-elevated)] text-[var(--text)]",
                "shadow-lg p-3 font-[var(--font-sans)] text-[12px]",
              )}
              // Prevent leave when the user moves over the tooltip
              // itself (otherwise hover-out → tooltip-out fires
              // before the user can click).
              onMouseEnter={() => {
                if (timer.current) clearTimeout(timer.current);
              }}
              onMouseLeave={onLeave}
            >
              <div
                data-testid={testId ? `${testId}-location` : undefined}
                className="font-[var(--font-mono)] text-[11px] text-[var(--muted)] truncate"
              >
                {locationLabel}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid={testId ? `${testId}-open` : undefined}
                  onClick={(e) => {
                    void onOpenInEditor(e);
                  }}
                  className={cn(
                    "px-2 py-1 rounded-[var(--radius-sm)]",
                    "bg-[var(--accent)] text-[var(--accent-fg)]",
                    "text-[11px] hover:opacity-90",
                  )}
                >
                  Open in Editor
                </button>
                <button
                  type="button"
                  data-testid={testId ? `${testId}-copy` : undefined}
                  onClick={(e) => {
                    void onCopyPath(e);
                  }}
                  className={cn(
                    "px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--border)]",
                    "text-[11px] hover:bg-[var(--surface)]",
                  )}
                >
                  Copy path
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
