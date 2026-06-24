import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { OnboardingDropRepo } from "@/screens/onboarding/DropRepo";
import { OnboardingPowerUps } from "@/screens/onboarding/PowerUps";
import { OnboardingReady } from "@/screens/onboarding/Ready";
import { useOnboarding } from "@/lib/store/onboarding";

/**
 * Multi-step onboarding orchestrator. The 2026-05-07 chat-first
 * reframe rebranded the three steps:
 *
 *   - `drop`     → Welcome / the moat
 *   - `powerups` → AI key
 *   - `ready`    → Optional connect (repo / cloud / skip)
 *
 * Store keys stayed for backwards compat; only the visuals changed.
 * Each step component owns its own `OnboardingFrame` chrome
 * (titlebar + step indicator + actionbar), so the orchestrator
 * just cross-fades them.
 */
export function Onboarding() {
  const step = useOnboarding((s) => s.step);
  const reduce = useReducedMotion();

  return (
    <div
      data-testid="onboarding-shell"
      data-step={step}
      className="h-full w-full overflow-hidden relative"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          // Y micro-slide (same vertical motion as before) but the
          // motion.div itself is `position: absolute inset-0` so the
          // translate animates within an out-of-flow box — the parent
          // never sees a layout change, so no momentary scrollbar
          // appears, so no rightward "settle" at rest.
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={
            reduce
              ? { duration: 0 }
              : { duration: 0.22, ease: "easeOut" }
          }
          className="absolute inset-0"
        >
          {step === "drop" ? <OnboardingDropRepo /> : null}
          {step === "powerups" ? <OnboardingPowerUps /> : null}
          {step === "ready" ? <OnboardingReady /> : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
