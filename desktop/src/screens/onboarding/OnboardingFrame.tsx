import { type ReactNode } from "react";

import { WizardFrame } from "@/screens/wizard/WizardFrame";
import type { OnboardingStep } from "@/lib/store/onboarding";

const STEP_ORDER: OnboardingStep[] = ["drop", "powerups", "ready"];

interface OnboardingFrameProps {
  /** Which step we're rendering — drives the step-dot indicator. */
  step: OnboardingStep;
  /**
   * Body slot. Lives inside an overflow:hidden container; render
   * scrollable content yourself if needed.
   */
  children: ReactNode;
  /**
   * Action bar slot. Pass a flex row with back/continue/skip
   * buttons; the frame just provides the chrome (top border,
   * padding, height). Omit for screen 1 which uses a different
   * layout.
   */
  actionBar?: ReactNode;
  testId?: string;
}

/**
 * 3-step onboarding wrapper around the generic `WizardFrame`.
 *
 * Pre-S3 this owned the chrome implementation directly. Inari Live V1
 * Session 3 lifted the chrome into `WizardFrame` so the new
 * Add-Project wizard could reuse the same skin without duplicating
 * 90+ lines of CSS-in-style. Onboarding stays a thin wrapper that:
 *   1. Hardcodes the 3-step order from `OnboardingStep`.
 *   2. Pins the subtitle to "setup" (matches every existing
 *      screenshot + test).
 *   3. Forwards `step` → `currentStep` index so the dot indicator and
 *      monospace counter render the same as before.
 *
 * The exported `ONBOARDING_STEP_ORDER` keeps the same shape so any
 * call site that imports it (MainBoot etc.) doesn't need a touch.
 */
export function OnboardingFrame({ step, children, actionBar, testId }: OnboardingFrameProps) {
  const stepIdx = STEP_ORDER.indexOf(step);
  return (
    <WizardFrame
      subtitle="setup"
      steps={STEP_ORDER}
      currentStep={stepIdx >= 0 ? stepIdx : 0}
      actionBar={actionBar}
      testId={testId ?? "onboarding-frame"}
    >
      {children}
    </WizardFrame>
  );
}

export const ONBOARDING_STEP_ORDER = STEP_ORDER;
