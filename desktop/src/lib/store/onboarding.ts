/**
 * Zustand store for the Sesión-17 Onboarding flow.
 *
 * Drives the 3-screen sign-up animation (Drop / PowerUps / Ready). The
 * store keeps:
 *   - `step`            — current screen.
 *   - `repo`            — the repo accepted in step 1 (or null until then).
 *   - `progress`        — polling result from `onboarding_progress`.
 *   - `powerUps`        — opt-in flags collected in step 2.
 */

import { create } from "zustand";

import {
  completeOnboarding,
  configureHttpProxy,
  installShellHooks,
  installVscodeExtension,
  onboardingOpenRepo,
  onboardingProgress,
  type OnboardingProgress,
  type OnboardingRepo,
  type PowerUpResult,
} from "@/lib/main-ipc";

export type OnboardingStep = "drop" | "powerups" | "ready";
export type ShellKind = "zsh" | "bash" | "fish";

export interface PowerUpsState {
  watchTerminal: boolean;
  blockBadPushes: boolean;
  vscodeExtension: boolean;
  httpTraffic: boolean;
}

interface OnboardingStore {
  step: OnboardingStep;
  repo: OnboardingRepo | null;
  progress: OnboardingProgress;
  shellKind: ShellKind;
  powerUps: PowerUpsState;
  /** Latest applied power-up message, surfaced in the toast strip. */
  lastPowerUpResult: PowerUpResult | null;
  /** Set when `onboarding_open_repo` rejected — UI shows the message. */
  errorMessage: string | null;

  setStep: (step: OnboardingStep) => void;
  setShellKind: (k: ShellKind) => void;
  acceptRepo: (path: string) => Promise<void>;
  pollProgress: () => Promise<void>;
  togglePowerUp: (key: keyof PowerUpsState, enabled: boolean) => Promise<void>;
  finishOnboarding: () => Promise<void>;
}

export const detectShellKind = (): ShellKind => {
  // Best-effort guess from the user agent / platform. The user can flip
  // it manually in step 2; this just picks a reasonable default.
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "zsh";
    if (ua.includes("linux")) return "bash";
  }
  return "bash";
};

export const useOnboarding = create<OnboardingStore>((set, get) => ({
  step: "drop",
  repo: null,
  progress: { stage: "scanning", percent: 0, symbol_count: 0 },
  shellKind: detectShellKind(),
  powerUps: {
    watchTerminal: false,
    blockBadPushes: false,
    vscodeExtension: false,
    httpTraffic: false,
  },
  lastPowerUpResult: null,
  errorMessage: null,

  setStep: (step) => set({ step }),
  setShellKind: (k) => set({ shellKind: k }),

  acceptRepo: async (path) => {
    set({ errorMessage: null });
    try {
      const repo = await onboardingOpenRepo(path);
      set({ repo, errorMessage: null });
      // Kick a first poll so the UI shows the scanning state immediately.
      const progress = await onboardingProgress(repo.id);
      set({ progress });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ errorMessage: message });
    }
  },

  pollProgress: async () => {
    const { repo } = get();
    if (!repo) return;
    const progress = await onboardingProgress(repo.id);
    set({ progress });
  },

  togglePowerUp: async (key, enabled) => {
    set((s) => ({ powerUps: { ...s.powerUps, [key]: enabled } }));
    if (!enabled) return; // disabling is a UI-only action; nothing to install.
    let result: PowerUpResult;
    if (key === "watchTerminal") {
      const status = await installShellHooks(get().shellKind);
      result = {
        success: status.installed_for.length > 0,
        message: `Shell hook added to ~/.${get().shellKind}rc`,
      };
    } else if (key === "vscodeExtension") {
      result = await installVscodeExtension();
    } else if (key === "httpTraffic") {
      result = await configureHttpProxy(9876);
    } else {
      // blockBadPushes: ships the Sesión-8 git hook command. We surface a
      // success message; the actual install is per-repo and happens via
      // Settings → Sensors (or the user's first push).
      result = {
        success: true,
        message: "Pre-push gate enabled — installs on first push",
      };
    }
    set({ lastPowerUpResult: result });
  },

  finishOnboarding: async () => {
    await completeOnboarding();
  },
}));

export function __resetOnboardingStoreForTests(): void {
  useOnboarding.setState({
    step: "drop",
    repo: null,
    progress: { stage: "scanning", percent: 0, symbol_count: 0 },
    shellKind: "bash",
    powerUps: {
      watchTerminal: false,
      blockBadPushes: false,
      vscodeExtension: false,
      httpTraffic: false,
    },
    lastPowerUpResult: null,
    errorMessage: null,
  });
}
