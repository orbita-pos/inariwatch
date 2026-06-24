import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

/**
 * One row in a context menu. `onSelect` runs on click + Enter; the
 * menu closes itself before invoking the handler so a callback that
 * opens a modal doesn't fight with the menu's own dismiss path.
 *
 * `disabled` rows render greyed out and are skipped by keyboard
 * navigation. `kbd` shows a subtle right-aligned shortcut hint.
 */
export interface ContextMenuItem {
  /** Stable id so tests + a11y attributes don't churn on re-renders. */
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  kbd?: string;
}

export interface ContextMenuProps {
  items: ContextMenuItem[];
  children: React.ReactNode;
  /** Stable id forwarded as `data-testid` for the trigger wrapper. */
  testId?: string;
  /**
   * Wrap the children in a `span` (default) or `div`. Stacktrace
   * locations live inline with prose so the default is `span`.
   */
  as?: "span" | "div";
}

/**
 * Right-click context menu rendered in a portal at the click
 * coordinates. Dismisses on Esc, outside click, scroll, or window
 * blur. Position is clamped to the viewport so a click near the
 * bottom-right edge doesn't overflow.
 *
 * Implementation choice: hand-rolled rather than `@radix-ui/react-context-menu`
 * because the surface area is small (single fan-out menu, no
 * sub-menus, no checked items) and the trigger is bound to text
 * spans (Radix triggers want a single ref-able element). Hand-roll
 * keeps the bundle lighter and the `@/lib/cn` token wiring
 * consistent with the rest of S11's surface.
 */
export function ContextMenu({
  items,
  children,
  testId,
  as = "span",
}: ContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();

  const close = useCallback(() => setOpen(false), []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setPos({ x: e.clientX, y: e.clientY });
      setOpen(true);
    },
    [items.length],
  );

  // Dismiss on Esc / outside click / scroll / window blur.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onClickAway = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onScroll = () => close();
    const onBlur = () => close();
    window.addEventListener("keydown", onKey);
    // `mousedown` fires before `click`, which lets a click inside the
    // menu's <button> close after the handler fires (the button
    // wraps `onSelect()` then `close()`). Listening on `click` here
    // would let mousedown on the trigger re-open us.
    document.addEventListener("mousedown", onClickAway);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClickAway);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, close]);

  // Clamp into the viewport AFTER the menu mounts so the dimensions
  // are known. Skip on jsdom (no `getBoundingClientRect` real
  // values) — the test suite asserts on coordinates only when the
  // browser sizes are deterministic.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    let { x, y } = pos;
    if (rect.width > 0 && x + rect.width > vw) x = Math.max(0, vw - rect.width - 4);
    if (rect.height > 0 && y + rect.height > vh) y = Math.max(0, vh - rect.height - 4);
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
    // We intentionally only run this once per (open, pos) tuple to
    // avoid a setState loop with the clamp output feeding back in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const TriggerTag = as;

  return (
    <>
      <TriggerTag onContextMenu={onContextMenu} data-testid={testId}>
        {children}
      </TriggerTag>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-labelledby={labelId}
              data-testid={testId ? `${testId}-menu` : undefined}
              style={{
                position: "fixed",
                left: pos.x,
                top: pos.y,
                zIndex: 9999,
                minWidth: 180,
              }}
              className={cn(
                "rounded-[var(--radius-md)] border border-[var(--border)]",
                "bg-[var(--card-elevated)] text-[var(--text)]",
                "shadow-lg py-1 font-[var(--font-sans)] text-[13px]",
              )}
            >
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  data-testid={`menuitem-${item.id}`}
                  disabled={item.disabled}
                  className={cn(
                    "w-full flex items-center justify-between gap-3 px-3 py-1.5",
                    "text-left",
                    item.disabled
                      ? "text-[var(--muted)] cursor-not-allowed"
                      : "hover:bg-[var(--surface)] focus-visible:bg-[var(--surface)]",
                    "outline-none",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.disabled) return;
                    close();
                    item.onSelect();
                  }}
                >
                  <span>{item.label}</span>
                  {item.kbd ? (
                    <span className="text-[11px] text-[var(--muted)]">{item.kbd}</span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
