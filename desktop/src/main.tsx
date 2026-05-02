import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { isOnboarded } from "@/lib/main-ipc";
import { useOnboarding } from "@/lib/store/onboarding";
import { AppProviders } from "@/lib/boot";
import { MainWindow } from "@/screens/MainWindow";
import { Onboarding } from "@/screens/Onboarding";

/**
 * Main webview boot. Sesión 17 gates between Onboarding (first-run) and
 * the real MainWindow shell based on `is_onboarded` IPC. Until the IPC
 * resolves, a minimal splash holds the layout (avoids flash-of-content).
 *
 * The dock surface boots from `dock.tsx`; that file unchanged in S17.
 */
function MainBoot() {
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const setOnboardingStep = useOnboarding((s) => s.setStep);
  const onboardingFinished = useOnboarding((s) => s.finished);

  useEffect(() => {
    let cancelled = false;
    isOnboarded()
      .then((state) => {
        if (!cancelled) setOnboarded(state.onboarded);
      })
      .catch(() => {
        // No daemon reachable — assume not onboarded so the user sees
        // the welcome flow rather than a blank shell.
        if (!cancelled) setOnboarded(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Flip the gate the moment finishOnboarding() resolves — no DB
  // round-trip, no window reload. The `finished` flag in the
  // onboarding store is the canonical in-memory signal so the user
  // doesn't get stuck on the Ready screen waiting for a refresh.
  useEffect(() => {
    if (onboardingFinished) setOnboarded(true);
  }, [onboardingFinished]);

  // Reset onboarding store on every fresh mount so a back-out re-entry
  // doesn't carry state across sessions of the window.
  useEffect(() => {
    setOnboardingStep("drop");
  }, [setOnboardingStep]);

  if (onboarded === null) {
    return (
      <div
        data-testid="main-splash"
        className="h-full w-full flex items-center justify-center text-sm text-[var(--muted)]"
      >
        …
      </div>
    );
  }

  return onboarded ? <MainWindow /> : <Onboarding />;
}

const container = document.getElementById("root");
if (!container) throw new Error("main.tsx: #root not found");

createRoot(container).render(
  <React.StrictMode>
    <AppProviders>
      <MainBoot />
    </AppProviders>
  </React.StrictMode>,
);
