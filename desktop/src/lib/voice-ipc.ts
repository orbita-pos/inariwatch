/**
 * S9 — typed wrappers for the desktop_voice_* Tauri commands + the
 * existing v0.3 S5 voice_synthesize handler.
 *
 * Mirrors the pattern in `dock-ipc.ts` / `main-ipc.ts`: each helper
 * wraps `invoke` with concrete types so tests can mock the module
 * boundary instead of `@tauri-apps/api/core`. When the backend isn't
 * registered (vitest/jsdom), the helpers throw — callers must either
 * mock the module or render a degraded path.
 */

import { invoke } from "@tauri-apps/api/core";

// ── DTOs ────────────────────────────────────────────────────────────
//
// Hand-written shapes mirror `desktop/src-tauri/src/voice/{settings,
// stt}.rs` + `desktop/src-tauri/src/voice/capabilities.rs`. ts-rs
// regenerates the canonical types under `lib/types/` on
// `cargo test --lib`; the duplicate hand-written shapes here keep
// build-time types stable without forcing a `cargo test` before
// `tsc`.

export interface VoiceCapabilities {
  stt_available: boolean;
  stt_binary_path: string;
  whisper_model_present: boolean;
  whisper_model_path: string;
  tts_available: boolean;
  piper_model_present: boolean;
}

export interface VoiceSettings {
  input_enabled: boolean;
  output_enabled: boolean;
  stt_model_path: string;
  tts_voice: string;
  auto_speak_responses: boolean;
  push_to_talk: boolean;
}

export interface VoiceSettingsPatch {
  input_enabled?: boolean;
  output_enabled?: boolean;
  stt_model_path?: string;
  tts_voice?: string;
  auto_speak_responses?: boolean;
  push_to_talk?: boolean;
}

export interface TranscriptionResult {
  text: string;
  /** `whisper_cli` for production runs, `mock` in tests. */
  engine: string;
  audio_duration_ms: number;
}

export type AudioFmt = "wav";

export interface VoiceSynthesizeResponse {
  audio_wav_b64: string;
  voice_id: string;
  engine: string;
  duration_ms: number;
  sample_rate_hz: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  input_enabled: false,
  output_enabled: false,
  stt_model_path: "",
  tts_voice: "",
  auto_speak_responses: false,
  push_to_talk: true,
};

export const DEFAULT_VOICE_CAPABILITIES: VoiceCapabilities = {
  stt_available: false,
  stt_binary_path: "",
  whisper_model_present: false,
  whisper_model_path: "",
  tts_available: false,
  piper_model_present: false,
};

// ── IPC wrappers ────────────────────────────────────────────────────

export async function getVoiceCapabilities(): Promise<VoiceCapabilities> {
  return invoke<VoiceCapabilities>("desktop_voice_capabilities");
}

export async function transcribeAudio(
  audioB64: string,
  fmt: AudioFmt = "wav",
  language?: string,
): Promise<TranscriptionResult> {
  return invoke<TranscriptionResult>("desktop_voice_transcribe", {
    audioB64,
    fmt,
    language,
  });
}

export async function getVoiceSettings(): Promise<VoiceSettings> {
  return invoke<VoiceSettings>("desktop_voice_get_settings");
}

export async function setVoiceSettings(
  patch: VoiceSettingsPatch,
): Promise<VoiceSettings> {
  return invoke<VoiceSettings>("desktop_voice_set_settings", { patch });
}

/**
 * v0.3 S5 — synthesize text → WAV bytes (base64).
 * Re-exported here so the chat surface can hit a single voice module
 * for both speak + listen.
 */
export async function synthesizeSpeech(
  text: string,
  voiceId?: string,
  speed?: number,
): Promise<VoiceSynthesizeResponse> {
  return invoke<VoiceSynthesizeResponse>("voice_synthesize", {
    text,
    voiceId,
    speed,
  });
}

// ── Browser-side WAV transcoding ────────────────────────────────────
//
// MediaRecorder produces WebM/Opus on Chromium (the fallback path
// when WAV isn't available, which is most browsers). whisper-cli
// only consumes WAV, and symphonia 0.5 doesn't have a stable Opus
// decoder — so we transcode in the browser via Web Audio API and
// hand the backend a 16 kHz mono WAV. Side benefit: the codec stays
// in the browser, where it's already part of the platform.

const WHISPER_SAMPLE_RATE_HZ = 16_000;

/**
 * Decode a recorded blob (any browser-supported codec) and return a
 * fresh ArrayBuffer that contains a 16 kHz mono WAV. The caller
 * base64-encodes it before handing it to `transcribeAudio`.
 *
 * The function is async because `decodeAudioData` is. It is a no-op
 * to call in tests as long as `globalThis.AudioContext` /
 * `OfflineAudioContext` are stubbed.
 */
export async function blobToWavBytes(blob: Blob): Promise<ArrayBuffer> {
  const ctxClass: typeof AudioContext | undefined =
    (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!ctxClass) {
    throw new Error("AudioContext is not available — running outside a browser?");
  }
  const offlineClass: typeof OfflineAudioContext | undefined = (
    globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }
  ).OfflineAudioContext;
  if (!offlineClass) {
    throw new Error("OfflineAudioContext is not available — cannot resample to 16 kHz");
  }

  const arrayBuf = await blob.arrayBuffer();
  // `decodeAudioData` requires a live AudioContext.
  const ctx = new ctxClass();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    void ctx.close();
  }

  const offline = new offlineClass(
    1,
    Math.ceil((decoded.duration * WHISPER_SAMPLE_RATE_HZ) || 1),
    WHISPER_SAMPLE_RATE_HZ,
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return audioBufferToWav(rendered);
}

/**
 * Encode a base64 string from raw bytes. Standard alphabet, padding
 * preserved. Pure JS — avoids dragging a polyfill for `btoa` on
 * binary data (`btoa(String.fromCharCode(...))` chokes past ~64 KB).
 */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  while (i + 3 <= bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPH[(n >> 18) & 0x3f] +
      ALPH[(n >> 12) & 0x3f] +
      ALPH[(n >> 6) & 0x3f] +
      ALPH[n & 0x3f];
    i += 3;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += ALPH[(n >> 18) & 0x3f] + ALPH[(n >> 12) & 0x3f] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      ALPH[(n >> 18) & 0x3f] +
      ALPH[(n >> 12) & 0x3f] +
      ALPH[(n >> 6) & 0x3f] +
      "=";
  }
  return out;
}

/**
 * Pick the first MediaRecorder mimeType the host browser supports.
 * WebM/Opus is the Chromium default; WAV works rarely but is
 * passthrough; the empty string lets MediaRecorder pick its native
 * default if neither is supported (Safari).
 */
export function preferredRecorderMimeType(): string {
  const ts: string[] = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/wav",
  ];
  const recorder = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder })
    .MediaRecorder;
  if (!recorder?.isTypeSupported) {
    return "";
  }
  for (const t of ts) {
    if (recorder.isTypeSupported(t)) {
      return t;
    }
  }
  return "";
}

/**
 * Serialize an `AudioBuffer` (mono or multi-channel) to a 16-bit PCM
 * WAV. Mono input is passthrough; multi-channel collapses to mono by
 * averaging. The output sample rate is whatever the buffer carries —
 * callers wanting 16 kHz must resample first via OfflineAudioContext.
 */
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = 1;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const numFrames = buffer.length;

  // Mix down to mono if the buffer is multi-channel.
  const mono = new Float32Array(numFrames);
  if (buffer.numberOfChannels === 1) {
    mono.set(buffer.getChannelData(0));
  } else {
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < numFrames; i++) {
      mono[i] = (left[i] + right[i]) * 0.5;
    }
  }

  const dataSize = numFrames * channels * (bitsPerSample / 8);
  const headerSize = 44;
  const out = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(out);

  // RIFF header.
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples.
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
