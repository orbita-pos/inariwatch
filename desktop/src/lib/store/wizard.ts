/**
 * Zustand store driving the Inari Live V1 — Session 3 Add-Project
 * wizard. Five steps:
 *   1. detect  — auto-runs on mount, scans `~/code` etc.
 *   2. plan    — confirms the 5-action plan (npm, patch, .env, mint, sync)
 *   3. install — live progress while the install pipeline runs
 *   4. run-dev — "Run dev now" button + ready watcher
 *   5. verify  — listens to web SSE for first event arrival
 *
 * The store also acts as the single subscriber of the
 * `wizard:progress` Tauri event so multiple components can render off
 * the same log tail without listener fan-out.
 */

import { create } from "zustand";

import {
  type DetectionResult,
  type InstallArgs,
  type InstallResult,
  type RunDevArgs,
  type RunDevResult,
  type WizardPayload,
  type WizardProgress,
  onWizardProgress,
  wizardCopyProjectTokenToClipboard,
  wizardDetectClone,
  wizardDismiss,
  wizardGetPending,
  wizardInjectTestEvent,
  wizardOpenHostDashboard,
  wizardRunDev,
  wizardRunInstall,
} from "@/lib/ipc/wizard";
import { getHostMeta, type HostId } from "@/lib/wizard/hosts";

export type WizardStep =
  | "detect"
  | "plan"
  | "install"
  | "host-sync"
  | "run-dev"
  | "verify";

export const WIZARD_STEPS: WizardStep[] = [
  "detect",
  "plan",
  "install",
  "host-sync",
  "run-dev",
  "verify",
];

export interface WizardLogEntry {
  stage:   string;
  message: string;
  at:      number;
}

interface WizardState {
  /** Active payload — null when no wizard is open. */
  payload:    WizardPayload | null;
  step:       WizardStep;
  /** Progress 0..=1 — drives the global wizard progress bar. */
  fraction:   number;
  /** Detection result; null until `runDetect` returns. */
  detection:  DetectionResult | null;
  /** User override for the local clone path. Null = use detection. */
  pathOverride: string | null;
  /** Install pipeline outcome; null until `runInstall` succeeds. */
  install:    InstallResult | null;
  /** Run-dev outcome; null until `runDev` returns (success OR with note). */
  runDev:     RunDevResult | null;
  /** Tail of progress events for the live-log panel. Capped at 200. */
  log:        WizardLogEntry[];
  /** Last error surfaced by any pipeline step, or null. */
  error:      string | null;
  /** True once the web SSE `first_event` arrived. */
  verified:   boolean;

  // ── Session 4 — host-sync state ───────────────────────────────────────────

  /**
   * Effective host id for the host-sync step. Defaults to detection.host
   * (or the wizard payload host) but the user can override via the
   * dropdown in the host-sync step. Null = "Pick your host" mode.
   */
  hostOverride: HostId | null;
  /** True once the user has clicked "I've added it" in the host-sync step. */
  hostAcknowledged: boolean;
  /** Status of the most recent token-to-clipboard copy attempt. */
  clipboardStatus: "idle" | "copied" | "error";

  /** Tauri unlisten handle for the in-flight progress subscription. */
  _unlistenProgress: (() => void) | null;

  /** Boot — call from `AddProjectWizard` mount. */
  initialize:    () => Promise<void>;
  setPayload:    (payload: WizardPayload) => void;
  setStep:       (step: WizardStep) => void;
  setPathOverride: (path: string | null) => void;
  runDetect:     () => Promise<void>;
  runInstall:    () => Promise<void>;
  runDevServer:  () => Promise<void>;
  injectTestEvent: () => Promise<void>;
  markVerified:  () => void;
  appendLog:     (entry: WizardProgress) => void;
  reset:         () => void;
  dismiss:       () => Promise<void>;

  // Session 4 — host-sync transitions.
  setHostOverride:  (host: HostId | null) => void;
  copyTokenToClipboard: () => Promise<void>;
  openHostDashboard:    () => Promise<void>;
  acknowledgeHostSetup: () => void;
}

const LOG_CAP = 200;

export const useWizard = create<WizardState>((set, get) => ({
  payload: null,
  step: "detect",
  fraction: 0,
  detection: null,
  pathOverride: null,
  install: null,
  runDev: null,
  log: [],
  error: null,
  verified: false,
  hostOverride: null,
  hostAcknowledged: false,
  clipboardStatus: "idle",
  _unlistenProgress: null,

  initialize: async () => {
    // Subscribe to progress once per app session — even if the wizard
    // closes / reopens we keep the same channel.
    if (get()._unlistenProgress === null) {
      const off = await onWizardProgress((p) => get().appendLog(p));
      set({ _unlistenProgress: off });
    }
    const pending = await wizardGetPending();
    if (pending) {
      get().setPayload(pending);
    }
  },

  setPayload: (payload) => {
    set({
      payload,
      step: "detect",
      fraction: 0,
      detection: null,
      pathOverride: null,
      install: null,
      runDev: null,
      log: [],
      error: null,
      verified: false,
      hostOverride: null,
      hostAcknowledged: false,
      clipboardStatus: "idle",
    });
    void get().runDetect();
  },

  setStep: (step) => set({ step }),

  setPathOverride: (path) => set({ pathOverride: path }),

  runDetect: async () => {
    const payload = get().payload;
    if (!payload) return;
    set({ error: null });
    try {
      const result = await wizardDetectClone(payload.repoFullName);
      set({ detection: result });
      // Auto-advance to plan only when we found a path. Otherwise stay
      // on detect so the user can paste an override.
      if (result.path) set({ step: "plan" });
    } catch (e) {
      set({ error: humanizeError(e) });
    }
  },

  runInstall: async () => {
    const payload = get().payload;
    if (!payload) return;
    const detection = get().detection;
    const repoPath = get().pathOverride ?? detection?.path ?? null;
    if (!repoPath) {
      set({ error: "No local clone selected. Pick a folder first." });
      return;
    }
    const framework = detection?.framework ?? "node";
    const host = detection?.host ?? payload.host ?? null;
    set({ step: "install", error: null, fraction: 0 });
    const args: InstallArgs = {
      projectId: payload.projectId,
      repoPath,
      framework,
      host,
    };
    try {
      const result = await wizardRunInstall(args);
      // Inari Live V1 — Session 4. Branch on the post-install host.
      // Tier 1 (vercel + sync ok)         → straight to run-dev (S3 behaviour).
      // Tier 1 (vercel + sync FAILED)     → host-sync so user can paste manually.
      // Tier 2 / Tier 3 / null detection  → host-sync.
      const tierOneSynced = host === "vercel" && result.vercel_synced;
      const nextStep: WizardStep = tierOneSynced ? "run-dev" : "host-sync";
      set({
        install: result,
        step: nextStep,
        fraction: 1,
        // Pre-seed hostOverride from detection so the host-sync step has
        // a starting selection. Null when detection failed — UI renders
        // the dropdown.
        hostOverride: (host as HostId | null) ?? null,
        hostAcknowledged: false,
        clipboardStatus: "idle",
      });
    } catch (e) {
      set({ error: humanizeError(e), step: "install" });
    }
  },

  runDevServer: async () => {
    const payload = get().payload;
    if (!payload) return;
    const repoPath = get().pathOverride ?? get().detection?.path ?? null;
    if (!repoPath) {
      set({ error: "No local clone selected. Pick a folder first." });
      return;
    }
    set({ step: "run-dev", error: null, fraction: 0 });
    const args: RunDevArgs = { projectId: payload.projectId, repoPath };
    try {
      const result = await wizardRunDev(args);
      // The webhook 2xx'd the test event — that's authoritative proof
      // that the capture pipeline accepted it AND (if state was
      // wizard-active) flipped to `verified` server-side. We set
      // `verified=true` locally so the wizard succeeds even when the
      // SSE listener can't reach the cloud (Tauri webview has no
      // session cookie). The SSE listener still upgrades the UI when
      // available.
      set({
        runDev: result,
        step: "verify",
        fraction: 1,
        verified: result.injected === true,
      });
    } catch (e) {
      set({ error: humanizeError(e), step: "run-dev" });
    }
  },

  injectTestEvent: async () => {
    const payload = get().payload;
    if (!payload) return;
    set({ error: null });
    try {
      await wizardInjectTestEvent(payload.projectId);
      // Same rationale as runDevServer — POST 2xx is success proof.
      set({ verified: true });
    } catch (e) {
      set({ error: humanizeError(e) });
    }
  },

  markVerified: () => set({ verified: true }),

  appendLog: (entry) => {
    set((state) => {
      const logEntry: WizardLogEntry = {
        stage: entry.stage,
        message: entry.message,
        at: Date.now(),
      };
      const next = [...state.log, logEntry].slice(-LOG_CAP);
      const fraction = entry.fraction ?? state.fraction;
      return { log: next, fraction };
    });
  },

  reset: () => set({
    payload: null,
    step: "detect",
    fraction: 0,
    detection: null,
    pathOverride: null,
    install: null,
    runDev: null,
    log: [],
    error: null,
    verified: false,
    hostOverride: null,
    hostAcknowledged: false,
    clipboardStatus: "idle",
  }),

  dismiss: async () => {
    await wizardDismiss();
    get().reset();
  },

  // ── Session 4 — host-sync transitions ─────────────────────────────────────

  setHostOverride: (host) => set({
    hostOverride: host,
    // A host change invalidates the previous "I've added it" click —
    // user must re-confirm against the new host.
    hostAcknowledged: false,
    clipboardStatus: "idle",
  }),

  copyTokenToClipboard: async () => {
    const payload = get().payload;
    if (!payload) {
      set({ error: "Wizard payload missing", clipboardStatus: "error" });
      return;
    }
    try {
      await wizardCopyProjectTokenToClipboard(payload.projectId);
      set({ clipboardStatus: "copied", error: null });
    } catch (e) {
      set({ clipboardStatus: "error", error: humanizeError(e) });
    }
  },

  openHostDashboard: async () => {
    const hostId = get().hostOverride ?? get().detection?.host ?? null;
    const meta   = getHostMeta(hostId);
    if (!meta?.dashboardUrl) {
      // Tier 3 / no-deeplink hosts simply skip the open call. Caller
      // surfaces this with a hint in the UI rather than an error toast.
      return;
    }
    try {
      await wizardOpenHostDashboard(meta.dashboardUrl);
    } catch (e) {
      set({ error: humanizeError(e) });
    }
  },

  acknowledgeHostSetup: () => {
    // "I've added it" → flip to run-dev so the user can fire a test
    // event locally + start the SSE wait. The 5-min "soft watch" is
    // implemented purely via the SSE listener already wired in
    // AddProjectWizard's `useEffect` for run-dev / verify steps; we
    // don't need a server-side state change.
    set({ hostAcknowledged: true, step: "run-dev", error: null });
  },
}));

// Re-export for tests + the React layer that switches on tier.
export { tierOf as wizardHostTierOf } from "@/lib/wizard/hosts";
export type { HostId } from "@/lib/wizard/hosts";

function humanizeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return "Unknown error"; }
}
