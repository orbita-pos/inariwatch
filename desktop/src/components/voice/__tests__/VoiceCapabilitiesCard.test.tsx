/**
 * S9 — VoiceCapabilitiesCard render tests.
 *
 * Asserts the ✓/✗ + "ready/missing" status lands on the right rows and
 * the install hint shows up exactly when STT prerequisites are
 * incomplete (binary OR model missing).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { VoiceCapabilities } from "@/lib/voice-ipc";
import { VoiceCapabilitiesCard } from "../VoiceCapabilitiesCard";

const ALL_OK: VoiceCapabilities = {
  stt_available: true,
  stt_binary_path: "/usr/local/bin/whisper-cli",
  whisper_model_present: true,
  whisper_model_path: "/home/me/.inari/voice/models/ggml-base.en.bin",
  tts_available: true,
  piper_model_present: true,
};

const ALL_MISSING: VoiceCapabilities = {
  stt_available: false,
  stt_binary_path: "",
  whisper_model_present: false,
  whisper_model_path: "/home/me/.inari/voice/models/ggml-base.en.bin",
  tts_available: false,
  piper_model_present: false,
};

describe("VoiceCapabilitiesCard", () => {
  it("renders all-ok summary when every probe passes", () => {
    render(<VoiceCapabilitiesCard capabilities={ALL_OK} />);
    expect(screen.getByTestId("voice-capabilities-overall")).toHaveTextContent(/all systems go/i);
    expect(screen.getByTestId("voice-cap-stt-status")).toHaveTextContent(/ready/i);
    expect(screen.getByTestId("voice-cap-stt-model-status")).toHaveTextContent(/ready/i);
    expect(screen.getByTestId("voice-cap-tts-status")).toHaveTextContent(/ready/i);
    expect(screen.getByTestId("voice-cap-tts-model-status")).toHaveTextContent(/ready/i);
    // Install hint hidden when STT prerequisites are complete.
    expect(screen.queryByTestId("voice-install-hint")).not.toBeInTheDocument();
  });

  it("renders setup-needed summary + install hint when STT is missing", () => {
    render(<VoiceCapabilitiesCard capabilities={ALL_MISSING} platformOverride="linux" />);
    expect(screen.getByTestId("voice-capabilities-overall")).toHaveTextContent(/setup needed/i);
    expect(screen.getByTestId("voice-cap-stt-status")).toHaveTextContent(/missing/i);
    expect(screen.getByTestId("voice-cap-stt-model-status")).toHaveTextContent(/missing/i);
    // Install hint shows up because STT pieces are missing.
    expect(screen.getByTestId("voice-install-hint")).toBeInTheDocument();
  });

  it("shows install hint when only the model is missing", () => {
    const caps: VoiceCapabilities = {
      ...ALL_OK,
      whisper_model_present: false,
    };
    render(<VoiceCapabilitiesCard capabilities={caps} platformOverride="mac" />);
    expect(screen.getByTestId("voice-install-hint")).toBeInTheDocument();
  });

  it("shows the resolved binary path under the STT row when available", () => {
    render(<VoiceCapabilitiesCard capabilities={ALL_OK} />);
    expect(screen.getByText("/usr/local/bin/whisper-cli")).toBeInTheDocument();
  });
});
