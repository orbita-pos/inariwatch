/**
 * S9 — Zustand store for voice settings + capabilities.
 *
 * Mirrors `lib/store/settings.ts`'s pattern: backend is the source of
 * truth, the store holds an optimistic mirror that the UI reads. Every
 * write goes through `desktop_voice_set_settings` and replaces the
 * mirror with the canonical response.
 *
 * Capabilities are read-only — cached after first probe + refreshed
 * via `refreshCapabilities()` when the Settings screen mounts or the
 * user clicks "Re-check capabilities".
 */

import { create } from "zustand";

import {
  DEFAULT_VOICE_CAPABILITIES,
  DEFAULT_VOICE_SETTINGS,
  getVoiceCapabilities,
  getVoiceSettings,
  setVoiceSettings,
  type VoiceCapabilities,
  type VoiceSettings,
  type VoiceSettingsPatch,
} from "@/lib/voice-ipc";

interface VoiceStore {
  settings: VoiceSettings;
  capabilities: VoiceCapabilities;
  loaded: boolean;
  loadAll: () => Promise<void>;
  refreshCapabilities: () => Promise<void>;
  patch: (patch: VoiceSettingsPatch) => Promise<void>;
}

export const useVoiceSettings = create<VoiceStore>((set, get) => ({
  settings: DEFAULT_VOICE_SETTINGS,
  capabilities: DEFAULT_VOICE_CAPABILITIES,
  loaded: false,

  loadAll: async () => {
    const [settings, capabilities] = await Promise.all([
      getVoiceSettings().catch(() => DEFAULT_VOICE_SETTINGS),
      getVoiceCapabilities().catch(() => DEFAULT_VOICE_CAPABILITIES),
    ]);
    set({ settings, capabilities, loaded: true });
  },

  refreshCapabilities: async () => {
    try {
      const capabilities = await getVoiceCapabilities();
      set({ capabilities });
    } catch {
      // Leave previous snapshot in place — silent failure is OK; the
      // user can retry from the "Re-check" button.
    }
  },

  patch: async (patch: VoiceSettingsPatch) => {
    // Optimistic — flip locally first so the UI feels instant.
    const optimistic: VoiceSettings = { ...get().settings };
    if (patch.input_enabled !== undefined) optimistic.input_enabled = patch.input_enabled;
    if (patch.output_enabled !== undefined) optimistic.output_enabled = patch.output_enabled;
    if (patch.stt_model_path !== undefined) optimistic.stt_model_path = patch.stt_model_path;
    if (patch.tts_voice !== undefined) optimistic.tts_voice = patch.tts_voice;
    if (patch.auto_speak_responses !== undefined)
      optimistic.auto_speak_responses = patch.auto_speak_responses;
    if (patch.push_to_talk !== undefined) optimistic.push_to_talk = patch.push_to_talk;
    set({ settings: optimistic });
    try {
      const next = await setVoiceSettings(patch);
      set({ settings: next });
    } catch {
      // Reconcile back to the prior server view on error.
      try {
        const prior = await getVoiceSettings();
        set({ settings: prior });
      } catch {
        // Last resort — leave the optimistic value.
      }
    }
  },
}));

export function __resetVoiceStoreForTests(): void {
  useVoiceSettings.setState({
    settings: DEFAULT_VOICE_SETTINGS,
    capabilities: DEFAULT_VOICE_CAPABILITIES,
    loaded: false,
  });
}
