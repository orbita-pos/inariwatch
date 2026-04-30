import { motion, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";

import { CommandPalette } from "@/components/CommandPalette";
import { KbdHint } from "@/components/ui";

/**
 * Dock shell — Session 14 lays out the chrome only. Modes 2/3/4
 * (conversation, alert, diff) ship in Sessions 15/16. The visible body
 * here is the empty/idle hint + the palette trigger; everything else
 * is a placeholder hook point.
 *
 * The motion treatment locks the spec recap microinteraction:
 *   `scale: 0.96 → 1.0 + opacity: 0 → 1, 200ms spring`
 *
 * Reduced-motion users get a fade-only fallback so we never animate
 * scale/translate against their preference.
 */
export function DockShell() {
  const reduce = useReducedMotion();

  return (
    <div
      data-testid="dock-shell"
      className="h-full w-full flex items-center justify-center p-4"
    >
      <motion.section
        className={[
          "w-full h-full max-h-[480px] max-w-[720px]",
          "rounded-[var(--radius-2xl)] border border-[var(--border)]",
          "bg-[var(--bg)]/80 backdrop-blur-md shadow-[var(--shadow-3)]",
          "flex flex-col overflow-hidden",
        ].join(" ")}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
        transition={
          reduce
            ? { duration: 0.15 }
            : { type: "spring", stiffness: 320, damping: 24, mass: 0.6 }
        }
      >
        <header className="flex items-center justify-between px-4 h-12 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-[var(--color-ai)]" aria-hidden />
            <span>Inari Live</span>
          </div>
          <KbdHint>⌘ K</KbdHint>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center text-center p-6">
          <h1 className="font-[var(--font-serif)] text-xl text-[var(--text)] mb-1">
            Inari is ready
          </h1>
          <p className="text-sm text-[var(--muted)] max-w-[40ch]">
            Press <KbdHint>⌘ K</KbdHint> to chat, search this repo, or fix the latest error.
          </p>
        </main>

        <footer
          className="flex items-center justify-between px-4 h-9 border-t border-[var(--border)] text-xs text-[var(--muted)]"
          data-testid="dock-footer"
        >
          <span>idle</span>
          <span>
            <KbdHint>ESC</KbdHint> to close
          </span>
        </footer>
      </motion.section>

      <CommandPalette />
    </div>
  );
}
