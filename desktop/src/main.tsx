import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { isOnboarded } from "@/lib/main-ipc";
import { useOnboarding } from "@/lib/store/onboarding";
import { useWizard } from "@/lib/store/wizard";
import { onWizardOpened } from "@/lib/ipc/wizard";
import { AppProviders } from "@/lib/boot";
import { MainWindow } from "@/screens/MainWindow";
import { Onboarding } from "@/screens/Onboarding";
import { AddProjectWizard } from "@/screens/wizard/AddProjectWizard";

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
  const wizardPayload = useWizard((s) => s.payload);
  const setWizardPayload = useWizard((s) => s.setPayload);
  const initWizard = useWizard((s) => s.initialize);

  // Inari Live V1 — Session 3. Subscribe to the relay-driven
  // `wizard:opened` event the desktop emits when a `project.wizard.open`
  // task arrives over WS. Also pulls any pending payload that was
  // queued before the webview booted (relay delivered, store cached,
  // window opened later — common when the user has Inari Live in tray).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void initWizard();
    void (async () => {
      try {
        unlisten = await onWizardOpened((payload) => setWizardPayload(payload));
      } catch {
        // No Tauri runtime present (dev / test). Silently skip.
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [initWizard, setWizardPayload]);

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

  // S3 Add-Project wizard takes precedence over the main shell when
  // active — the wizard owns the entire window so the user isn't
  // distracted by the chat / settings beneath. Dismissing the wizard
  // (Done / Cancel) clears the payload and falls back to MainWindow.
  if (onboarded && wizardPayload) {
    return <AddProjectWizard />;
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
