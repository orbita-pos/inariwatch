import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { OnboardingDropRepo } from "@/screens/onboarding/DropRepo";
import { OnboardingPowerUps } from "@/screens/onboarding/PowerUps";
import { OnboardingReady } from "@/screens/onboarding/Ready";
import { useOnboarding } from "@/lib/store/onboarding";

/**
 * Multi-step onboarding orchestrator (Sesión 17).
 *
 * Three Linear-style sub-screens: drop / power-ups / ready. The active
 * step lives in `useOnboarding.step`. Cross-fades use the same
 * Framer pattern as `DockShell` (Sesión 15) — `<AnimatePresence mode="wait">`
 * keyed off the step.
 */
export function Onboarding() {
  const step = useOnboarding((s) => s.step);
  const reduce = useReducedMotion();
  const initial = reduce ? { opacity: 0 } : { opacity: 0, y: 6 };
  const animate = reduce ? { opacity: 1 } : { opacity: 1, y: 0 };
  const exit = reduce ? { opacity: 0 } : { opacity: 0, y: -6 };

  return (
    <div
      data-testid="onboarding-shell"
      data-step={step}
      className="h-full w-full bg-[var(--bg)] text-[var(--text)] flex items-center justify-center"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={initial}
          animate={animate}
          exit={exit}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="w-full"
        >
          {step === "drop" ? <OnboardingDropRepo /> : null}
          {step === "powerups" ? <OnboardingPowerUps /> : null}
          {step === "ready" ? <OnboardingReady /> : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
