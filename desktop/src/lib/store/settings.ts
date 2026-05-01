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
  RepoSummary,
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
  getReposList,
  getSensorsState,
  setAiSettings,
  setGeneralSettings,
  setNotificationsSettings,
  setPrivacySettings,
  setSensorEnabled,
  wipeRepoMemory,
} from "@/lib/main-ipc";

export type SettingsSection =
  | "general"
  | "repos"
  | "sensors"
  | "notifications"
  | "ai"
  | "privacy"
  | "about"
  | "account";

interface SettingsStore {
  activeSection: SettingsSection;
  general: GeneralSettings;
  notifications: NotificationsSettings;
  ai: AiSettings;
  privacy: PrivacySettings;
  about: AboutInfo | null;
  repos: RepoSummary[];
  sensors: SensorsState | null;
  loaded: boolean;

  setActiveSection: (s: SettingsSection) => void;
  loadAll: () => Promise<void>;
  patchGeneral: (patch: Partial<GeneralSettings>) => Promise<void>;
  patchNotifications: (patch: Partial<NotificationsSettings>) => Promise<void>;
  patchAi: (patch: { openai_key?: string; model_routing?: AiSettings["model_routing"] }) => Promise<void>;
  patchPrivacy: (patch: Partial<PrivacySettings>) => Promise<void>;
  toggleSensor: (sensorKind: string, enabled: boolean) => Promise<void>;
  refreshRepos: () => Promise<void>;
  wipeMemoryFor: (repoId: string) => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  activeSection: "general",
  general: DEFAULT_GENERAL,
  notifications: DEFAULT_NOTIFICATIONS,
  ai: DEFAULT_AI,
  privacy: DEFAULT_PRIVACY,
  about: null,
  repos: [],
  sensors: null,
  loaded: false,

  setActiveSection: (s) => set({ activeSection: s }),

  loadAll: async () => {
    const [general, notifications, ai, privacy, about, repos, sensors] = await Promise.all([
      getGeneralSettings(),
      getNotificationsSettings(),
      getAiSettings(),
      getPrivacySettings(),
      getAboutInfo(),
      getReposList(),
      getSensorsState(),
    ]);
    set({ general, notifications, ai, privacy, about, repos, sensors, loaded: true });
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

  refreshRepos: async () => {
    const repos = await getReposList();
    set({ repos });
  },

  wipeMemoryFor: async (repoId) => {
    await wipeRepoMemory(repoId);
    await get().refreshRepos();
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
    repos: [],
    sensors: null,
    loaded: false,
  });
}
