/**
 * Settings → Voice (2026-05-08 design pivot, Frame 1A literal match).
 *
 * Three groups: Input, Output, Transcription. Mirrors the comp 1:1.
 * Some controls are cosmetic placeholders until the IPC catches up
 * (mic device enumeration, partial-transcript streaming) — Phase B
 * wires them. The toggles that ARE wired (input_enabled,
 * output_enabled, auto_speak_responses, push_to_talk, tts_voice)
 * keep their existing voice-store hooks.
 */

import { useEffect, useState } from "react";

import {
  Dropdown,
  Segmented,
  SettingsField,
  SettingsGroup,
  SettingsHeader,
  Toggle,
} from "@/screens/settings/primitives";
import { useVoiceSettings } from "@/lib/store/voice";

interface VoiceListEntry {
  voice_id: string;
  display_name: string;
  language: string;
  installed: boolean;
}

type Mode = "ptt" | "hf";

const MODE_OPTIONS = [
  { value: "ptt" as const, label: "Push-to-talk" },
  { value: "hf" as const, label: "Hands-free" },
];

const MIC_OPTIONS = [
  { value: "default", label: "Default microphone" },
] as const;

export function SettingsVoice() {
  const settings = useVoiceSettings((s) => s.settings);
  const capabilities = useVoiceSettings((s) => s.capabilities);
  const loaded = useVoiceSettings((s) => s.loaded);
  const loadAll = useVoiceSettings((s) => s.loadAll);
  const refreshCapabilities = useVoiceSettings((s) => s.refreshCapabilities);
  const patch = useVoiceSettings((s) => s.patch);

  const [voiceList, setVoiceList] = useState<VoiceListEntry[]>([]);
  // Local-only state for the "Stream partial transcripts" toggle until
  // the wire-up lands. The user's choice survives the modal session
  // but resets on app reload — honest trade-off for a cosmetic field.
  const [streamPartials, setStreamPartials] = useState(false);

  useEffect(() => {
    if (!loaded) void loadAll();
  }, [loaded, loadAll]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const next = await invoke<VoiceListEntry[]>("voice_list_voices");
        if (!cancelled) setVoiceList(next);
      } catch {
        // No-op — settings still works without the voice list.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const missingStt = !capabilities.stt_available || !capabilities.whisper_model_present;
  const missingTts = !capabilities.tts_available;

  const mode: Mode = settings.push_to_talk ? "ptt" : "hf";
  const onModeChange = (next: Mode) => void patch({ push_to_talk: next === "ptt" });

  const voiceOptions = [
    { value: "", label: "Default · en_US-amy-medium" },
    ...voiceList
      .filter((v) => v.installed)
      .map((v) => ({
        value: v.voice_id,
        label: `${v.display_name} · ${v.language}`,
      })),
  ];

  return (
    <section data-testid="settings-voice" className="flex flex-col">
      <SettingsHeader
        title="Voice"
        description="Microphone input, text-to-speech, and local transcription settings."
      />

      <div className="mt-6" />

      <SettingsGroup eyebrow="Input">
        <SettingsField
          first
          label="Enable mic input"
          helper={
            missingStt ? (
              <span style={{ color: "var(--pending)" }}>
                Whisper STT not installed.{" "}
                <button
                  type="button"
                  onClick={() => void refreshCapabilities()}
                  className="hover:text-[var(--text)] transition-colors underline decoration-[var(--text-faint)] underline-offset-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  Re-check capabilities →
                </button>
              </span>
            ) : null
          }
          control={
            <Toggle
              testId="voice-toggle-input"
              ariaLabel="Enable mic input"
              on={settings.input_enabled && !missingStt}
              onChange={(b) => void patch({ input_enabled: b })}
              disabled={missingStt}
            />
          }
        />
        <SettingsField
          label="Mode"
          control={
            <Segmented<Mode>
              testId="voice-mode-segmented"
              options={MODE_OPTIONS}
              value={mode}
              onChange={onModeChange}
              disabled={!settings.input_enabled}
            />
          }
        />
        <SettingsField
          label="Mic device"
          control={
            <Dropdown
              testId="voice-mic-dropdown"
              options={MIC_OPTIONS}
              value="default"
              onChange={() => {
                /* Native picker — wired in Phase B */
              }}
              disabled={!settings.input_enabled}
              minWidth={240}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Output">
        <SettingsField
          first
          label="Speak Inari's responses"
          helper={
            missingTts ? (
              <span style={{ color: "var(--pending)" }}>
                Piper TTS not installed — synthetic fallback in use.
              </span>
            ) : null
          }
          control={
            <Toggle
              testId="voice-toggle-output"
              ariaLabel="Speak responses"
              on={settings.output_enabled}
              onChange={(b) => void patch({ output_enabled: b })}
            />
          }
        />
        <SettingsField
          label="Auto-speak streamed answers"
          helper="Enabled when output is on."
          control={
            <Toggle
              testId="voice-toggle-autospeak"
              ariaLabel="Auto-speak"
              on={settings.auto_speak_responses && settings.output_enabled}
              onChange={(b) => void patch({ auto_speak_responses: b })}
              disabled={!settings.output_enabled}
            />
          }
        />
        <SettingsField
          label="TTS voice"
          control={
            <Dropdown
              testId="voice-tts-voice"
              options={voiceOptions}
              value={settings.tts_voice ?? ""}
              onChange={(next) => void patch({ tts_voice: next })}
              disabled={!settings.output_enabled}
              minWidth={240}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup eyebrow="Transcription">
        <SettingsField
          first
          label="Use local Whisper"
          control={
            <Toggle
              testId="voice-toggle-local-whisper"
              ariaLabel="Use local Whisper"
              on={!missingStt}
              onChange={() => {
                /* Whisper is the only STT backend today; toggle is informational. */
              }}
              disabled
            />
          }
        />
        <SettingsField
          label="Stream partial transcripts"
          helper="Local Whisper keeps audio on this machine. Streaming costs ~12 ms/chunk."
          control={
            <Toggle
              testId="voice-toggle-stream-partials"
              ariaLabel="Stream partial transcripts"
              on={streamPartials}
              onChange={setStreamPartials}
              disabled={missingStt}
            />
          }
        />
      </SettingsGroup>
    </section>
  );
}
