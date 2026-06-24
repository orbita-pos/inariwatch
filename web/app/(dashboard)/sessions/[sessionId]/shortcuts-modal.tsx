"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

/**
 * Keyboard cheatsheet modal. Triggered by `?` from the player. Stays in
 * sync with the actual handler in player-v2.tsx — when adding a new
 * shortcut, edit BOTH places.
 *
 * Closes on ESC (handled by the player) and on backdrop click. Trap-focuses
 * the close button on open via autoFocus so screen readers land coherently.
 */

interface Shortcut {
  keys: string[];
  label: string;
}

const GROUPS: { name: string; items: Shortcut[] }[] = [
  {
    name: "Playback",
    items: [
      { keys: ["Space"], label: "Play / pause" },
      { keys: ["K"], label: "Play / pause (vi-style)" },
    ],
  },
  {
    name: "Seek",
    items: [
      { keys: ["←", "→"], label: "Back / forward 1 second" },
      { keys: ["J", "L"], label: "Back / forward 5 seconds" },
      { keys: [",", "."], label: "Jump to previous / next event" },
    ],
  },
  {
    name: "Other",
    items: [
      { keys: ["?"], label: "Toggle this cheatsheet" },
      { keys: ["Esc"], label: "Close cheatsheet" },
    ],
  },
];

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  // Lock body scroll while the modal is up — long replay pages would
  // otherwise scroll under the dialog when a wheel event lands on the dim.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="relative w-full max-w-md rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="shortcuts-title" className="text-sm font-semibold text-fg-strong">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            autoFocus
            className="rounded-md p-1 text-fg-base/60 hover:text-fg-base hover:bg-surface-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {GROUPS.map((g) => (
            <div key={g.name}>
              <h3 className="mb-2 text-[10px] uppercase tracking-wider text-fg-base/40">
                {g.name}
              </h3>
              <ul className="space-y-1.5">
                {g.items.map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-fg-base">{s.label}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, i) => (
                        <kbd
                          key={i}
                          className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-line bg-surface-inner px-1.5 py-0.5 font-mono text-[10px] text-fg-base/80 shadow-[0_1px_0_rgba(0,0,0,0.05)]"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-line bg-surface-inner/40 px-5 py-2.5 text-[11px] text-fg-base/50">
          Press <kbd className="rounded border border-line bg-surface px-1 font-mono">?</kbd> any time
          to reopen.
        </div>
      </div>
    </div>
  );
}
