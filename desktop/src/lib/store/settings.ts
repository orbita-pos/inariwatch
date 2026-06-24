/**
 * Zustand store for the Sesión-17 Settings screen.
 *
 * Each section's snapshot is loaded once on mount + refreshed
 * optimistically on save. The store does NOT persist to localStorage —
 * the SQL settings KV in the daemon is the source of truth (per the
 * prompt: "la verdad vive en backend (settings table)").
 */

import { create } from "zustand";

import type {
  AboutInfo,
  AiSettings,
  GeneralSettings,
  NotificationsSettings,
  PrivacySettings,
  SensorsState,
} from "@/lib/main-ipc";
import {
  DEFAULT_AI,
  DEFAULT_GENERAL,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_PRIVACY,
  getAboutInfo,
  getAiSettings,
  getGeneralSettings,
  getNotificationsSettings,
  getPrivacySettings,
  getSensorsState,
  setAiSettings,
  setGeneralSettings,
  setNotificationsSettings,
  setPrivacySettings,
  setSensorEnabled,
} from "@/lib/main-ipc";

export type SettingsSection =
  | "general"
  | "sensors"
  | "notifications"
  | "ai"
  // S8 — Channels (unified multi-messenger pairing). The standalone
  // WhatsApp tab was retired in V1.5; Channels is now the only
  // messaging surface.
  | "channels"
  | "voice"
  | "permissions"
  | "privacy"
  | "about"
  | "account"
  // Session 1 — paired Inari Live devices (multi-device).
  | "devices"
  // Inari Live V1 — list of projects watched across user's workspaces.
  // Read-only panel; Add / Resume Setup deeplink to the web dashboard.
  | "projects"
  // Jarvis-layer personal fact store (identity / preferences / skills /
  // patterns / context). Cross-session memory injected as Layer 0 in
  // every AI prompt.
  | "memory";

interface SettingsStore {
  activeSection: SettingsSection;
  general: GeneralSettings;
  notifications: NotificationsSettings;
  ai: AiSettings;
  privacy: PrivacySettings;
  about: AboutInfo | null;
  sensors: SensorsState | null;
  loaded: boolean;
  /**
   * S6 — when the chat surface deeplinks "permission denied → Open
   * Settings", it stamps the offending tool name here. The
   * `PermissionPanel` reads it on mount, scrolls the matching row
   * into view, briefly highlights it, and clears the slot so a manual
   * later visit doesn't re-trigger the highlight.
   */
  focusedTool: string | null;

  setActiveSection: (s: SettingsSection) => void;
  setFocusedTool: (tool: string | null) => void;
  loadAll: () => Promise<void>;
  patchGeneral: (patch: Partial<GeneralSettings>) => Promise<void>;
  patchNotifications: (patch: Partial<NotificationsSettings>) => Promise<void>;
  patchAi: (patch: { openai_key?: string; model_routing?: AiSettings["model_routing"]; local_chat_enabled?: boolean }) => Promise<void>;
  patchPrivacy: (patch: Partial<PrivacySettings>) => Promise<void>;
  toggleSensor: (sensorKind: string, enabled: boolean) => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  activeSection: "general",
  general: DEFAULT_GENERAL,
  notifications: DEFAULT_NOTIFICATIONS,
  ai: DEFAULT_AI,
  privacy: DEFAULT_PRIVACY,
  about: null,
  sensors: null,
  loaded: false,
  focusedTool: null,

  setActiveSection: (s) => set({ activeSection: s }),
  setFocusedTool: (tool) => set({ focusedTool: tool }),

  loadAll: async () => {
    const [general, notifications, ai, privacy, about, sensors] = await Promise.all([
      getGeneralSettings(),
      getNotificationsSettings(),
      getAiSettings(),
      getPrivacySettings(),
      getAboutInfo(),
      getSensorsState(),
    ]);
    set({ general, notifications, ai, privacy, about, sensors, loaded: true });
  },

  patchGeneral: async (patch) => {
    const optimistic = { ...get().general, ...patch };
    set({ general: optimistic });
    const next = await setGeneralSettings(patch);
    set({ general: next });
  },

  patchNotifications: async (patch) => {
    const optimistic = { ...get().notifications, ...patch };
    set({ notifications: optimistic });
    const next = await setNotificationsSettings(patch);
    set({ notifications: next });
  },

  patchAi: async (patch) => {
    const next = await setAiSettings(patch);
    set({ ai: next });
  },

  patchPrivacy: async (patch) => {
    const optimistic = { ...get().privacy, ...patch };
    set({ privacy: optimistic });
    const next = await setPrivacySettings(patch);
    set({ privacy: next });
  },

  toggleSensor: async (sensorKind, enabled) => {
    // Optimistic — flip the visible flag immediately, then reconcile.
    const current = get().sensors;
    if (current) {
      const optimistic = { ...current };
      if (sensorKind === "fs") optimistic.fs_enabled = enabled;
      if (sensorKind === "http") optimistic.http_proxy_enabled = enabled;
      set({ sensors: optimistic });
    }
    const next = await setSensorEnabled(sensorKind, enabled);
    set({ sensors: next });
  },
}));

/** Test helper. Resets the store between unit tests. */
export function __resetSettingsStoreForTests(): void {
  useSettings.setState({
    activeSection: "general",
    general: DEFAULT_GENERAL,
    notifications: DEFAULT_NOTIFICATIONS,
    ai: DEFAULT_AI,
    privacy: DEFAULT_PRIVACY,
    about: null,
    sensors: null,
    loaded: false,
    focusedTool: null,
  });
}
