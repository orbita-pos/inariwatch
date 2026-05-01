import { motion, useReducedMotion } from "framer-motion";

import { Button } from "@/components/ui";
import { hideDock, openMainWindow } from "@/lib/main-ipc";
import { useChat } from "@/lib/store/chat";
import { useOnboarding } from "@/lib/store/onboarding";

const PARTICLES = [-60, -40, -20, 20, 40, 60];

export function OnboardingReady() {
  const finishOnboarding = useOnboarding((s) => s.finishOnboarding);
  const startConversation = useChat((s) => s.startConversation);
  const setInputValue = useChat((s) => s.setInputValue);
  const reduce = useReducedMotion();

  async function askInari() {
    await finishOnboarding();
    setInputValue("What does this repo do?");
    startConversation();
    // Best-effort dock surfacing — when running outside Tauri this no-ops.
    await hideDock().catch(() => {});
  }

  async function exploreAlone() {
    await finishOnboarding();
    await openMainWindow("/").catch(() => {});
  }

  return (
    <div
      data-testid="onboarding-step-ready"
      className="flex flex-col items-center justify-center gap-6 max-w-xl mx-auto py-12 px-4 relative"
    >
      <div className="relative h-20 w-20" aria-hidden>
        {!reduce
          ? PARTICLES.map((dx, i) => (
              <motion.span
                key={i}
                className="absolute inset-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-[var(--accent)]"
                initial={{ opacity: 0, x: 0, y: 0, scale: 0.5 }}
                animate={{
                  opacity: [0, 1, 0],
                  x: dx,
                  y: -dx * 0.5,
                  scale: [0.5, 1.2, 0.5],
                }}
                transition={{ duration: 0.8, ease: "easeOut" }}
              />
            ))
          : null}
        <motion.div
          className="absolute inset-0 flex items-center justify-center font-[var(--font-serif)] text-3xl"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          ✓
        </motion.div>
      </div>
      <header className="text-center max-w-md">
        <h1 className="font-[var(--font-serif)] text-3xl mb-2">
          Inari is watching your code
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Cmd/Ctrl + Space pops the dock from anywhere.
        </p>
      </header>
      <div className="flex flex-col gap-2 items-center">
        <Button
          variant="primary"
          size="lg"
          onClick={askInari}
          data-testid="onboarding-ask-inari"
        >
          Ask Inari something
        </Button>
        <button
          type="button"
          className="text-xs text-[var(--muted)] hover:text-[var(--text)] underline-offset-2 hover:underline"
          onClick={exploreAlone}
          data-testid="onboarding-explore-alone"
        >
          I'll explore on my own
        </button>
      </div>
    </div>
  );
}
