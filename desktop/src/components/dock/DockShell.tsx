import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect } from "react";

import { DockConversation } from "@/screens/DockConversation";
import { DockIdle } from "@/screens/DockIdle";
import { installChatStreamDriver } from "@/lib/chat-stream";
import { useChat } from "@/lib/store/chat";

/**
 * Dock shell — Sesión 15 lights up the real Modes 1 (idle) and 2
 * (conversation). The shell is the outer card + open/close motion;
 * the active mode swaps in via Framer's `<AnimatePresence>` keyed off
 * `useChat.mode` so the cross-fade plays once per transition.
 *
 * Microinteractions (per spec recap):
 *   - Open dock:  scale 0.96 → 1.0 + opacity 0 → 1, ~200ms spring.
 *   - Close dock: scale 1.0 → 0.94 + opacity 1 → 0, ~150ms ease-in.
 * Reduced-motion users get an opacity-only fade for both.
 *
 * Streaming driver: installed once on mount. The driver emits tokens
 * to the chat store as the daemon publishes ChatTokenStream events
 * (Sesión 18); until that variant exists we fall through to a mock
 * stream so the conversation surface visibly responds to user input.
 */
export function DockShell() {
  const mode = useChat((s) => s.mode);
  const reduce = useReducedMotion();

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    installChatStreamDriver().then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div
      data-testid="dock-shell"
      data-mode={mode}
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
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
        transition={
          reduce
            ? { duration: 0.15 }
            : { type: "spring", stiffness: 320, damping: 24, mass: 0.6 }
        }
      >
        <AnimatePresence mode="wait" initial={false}>
          {mode === "idle" ? (
            <motion.div
              key="idle"
              className="h-full"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { duration: 0.18, ease: "easeOut" }
              }
            >
              <DockIdle />
            </motion.div>
          ) : (
            <motion.div
              key="conversation"
              className="h-full"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { duration: 0.18, ease: "easeOut" }
              }
            >
              <DockConversation />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>
    </div>
  );
}
