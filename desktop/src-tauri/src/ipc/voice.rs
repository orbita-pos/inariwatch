//! v0.3 S5 + S9 — voice Tauri commands.
//!
//! TTS surface (v0.3 S5):
//!   - [`voice_synthesize`] — text + voice id → WAV bytes (base64
//!     encoded for IPC transport). Frontend wraps the bytes in a
//!     `Blob` and plays via `HTMLAudioElement`.
//!   - [`voice_list_voices`] — registry surface for the Settings UI
//!     (lets users pick a default voice + see download sizes).
//!   - [`voice_status`] — reports whether Piper + voice models are
//!     installed yet, so the UI can render an "Install Piper" CTA
//!     before the toggle is flipped.
//!
//! STT + voice settings surface (S9):
//!   - [`desktop_voice_capabilities`] — combined STT/TTS health
//!     snapshot. Drives the Settings ✓/✗ chips and install hints.
//!   - [`desktop_voice_transcribe`] — base64 WAV → text via
//!     whisper-cli. Frontend records WebM/Opus, transcodes to
//!     16 kHz mono WAV in the browser, hands the bytes here.
//!   - [`desktop_voice_get_settings`] / [`desktop_voice_set_settings`]
//!     — persist [`VoiceSettings`] in the SQL KV table (the same
//!     store every other Settings sub-tab uses).
//!
//! Heavy-data IPC rule still applies — voice clips are short (≤ 30s
//! cap from the synth path, ≤ a few hundred KB), well below the 100KB
//! diff limit's spirit. STT input WAVs follow the same envelope (the
//! frontend caps recording at 30s before sending).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::store::Store;
use crate::voice::{
    self, capabilities, models, piper, settings as voice_settings, stt, stt::WhisperBackend,
    SynthesizeRequest,
};

/// Output shape for `voice_synthesize`. WAV bytes are base64-encoded
/// because Tauri IPC serializes via JSON (a raw `Vec<u8>` works but
/// adds 2-3x overhead from JSON-array notation; b64 is ~33%).
#[derive(Debug, Serialize)]
pub struct VoiceSynthesizeResponse {
    pub audio_wav_b64: String,
    pub voice_id: String,
    pub engine: String,
    pub duration_ms: u32,
    pub sample_rate_hz: u32,
}

#[tauri::command]
pub async fn voice_synthesize(
    app: AppHandle,
    text: String,
    voice_id: Option<String>,
    speed: Option<f32>,
) -> Result<VoiceSynthesizeResponse, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let req = SynthesizeRequest {
        text,
        voice_id,
        speed: speed.unwrap_or(1.0),
    };
    let result = voice::synthesize(&dir, req).map_err(|e| e.to_string())?;
    Ok(VoiceSynthesizeResponse {
        audio_wav_b64: voice::base64_encode(&result.audio_wav),
        voice_id: result.voice_id,
        engine: result.engine.as_str().to_string(),
        duration_ms: result.duration_ms,
        sample_rate_hz: voice::wav::SAMPLE_RATE_HZ,
    })
}

#[derive(Debug, Serialize)]
pub struct VoiceRegistryEntry {
    pub voice_id: String,
    pub display_name: String,
    pub language: String,
    pub quality: String,
    pub size_mb: u32,
    pub installed: bool,
}

#[tauri::command]
pub async fn voice_list_voices(
    app: AppHandle,
) -> Result<Vec<VoiceRegistryEntry>, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let voices_dir = piper::voice_models_dir(&dir);
    let mut out = Vec::with_capacity(models::VOICE_REGISTRY.len());
    for v in models::VOICE_REGISTRY {
        let installed = voices_dir.join(format!("{}.onnx", v.voice_id)).exists();
        out.push(VoiceRegistryEntry {
            voice_id: v.voice_id.to_string(),
            display_name: v.display_name.to_string(),
            language: v.language.to_string(),
            quality: v.quality.as_str().to_string(),
            size_mb: v.size_mb,
            installed,
        });
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct VoiceStatusResponse {
    pub piper_installed: bool,
    pub piper_path: String,
    pub installed_voice_count: u32,
    pub registered_voice_count: u32,
}

#[tauri::command]
pub async fn voice_status(app: AppHandle) -> Result<VoiceStatusResponse, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let voices_dir = piper::voice_models_dir(&dir);
    let mut installed: u32 = 0;
    for v in models::VOICE_REGISTRY {
        if voices_dir.join(format!("{}.onnx", v.voice_id)).exists() {
            installed += 1;
        }
    }
    Ok(VoiceStatusResponse {
        piper_installed: piper::binary_installed(&dir),
        piper_path: piper::piper_binary_path(&dir).display().to_string(),
        installed_voice_count: installed,
        registered_voice_count: models::VOICE_REGISTRY.len() as u32,
    })
}

// ── S9 — STT + voice settings ────────────────────────────────────────

/// Resolve the user home dir for capabilities probing. `dirs` already
/// in the runtime dep set; on the rare machine where it returns
/// `None` capabilities falls back to `app_local_data_dir`.
fn resolved_home() -> Option<std::path::PathBuf> {
    dirs::home_dir()
}

#[tauri::command]
pub async fn desktop_voice_capabilities(
    app: AppHandle,
) -> Result<voice::VoiceCapabilities, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let home = resolved_home();
    Ok(capabilities::detect(home.as_deref(), &dir))
}

/// Audio container the frontend recorded. WAV is the only format
/// whisper-cli accepts directly; the browser converts WebM/Opus →
/// 16 kHz mono WAV before sending. We accept the enum so the IPC
/// surface can grow new formats later (server-side decode) without a
/// breaking change.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFmt {
    Wav,
}

#[tauri::command]
pub async fn desktop_voice_transcribe(
    app: AppHandle,
    audio_b64: String,
    fmt: Option<AudioFmt>,
    language: Option<String>,
) -> Result<voice::TranscriptionResult, String> {
    let fmt = fmt.unwrap_or(AudioFmt::Wav);
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {}", e))?;
    let home = resolved_home();

    let wav_bytes = match fmt {
        AudioFmt::Wav => decode_b64(&audio_b64).map_err(|e| format!("invalid base64: {e}"))?,
    };

    let backend = voice::WhisperCliBackend::from_dirs(home.as_deref(), &dir)
        .ok_or_else(|| stt::TranscribeError::BinaryMissing.to_string())?;

    let opts = stt::TranscribeOpts {
        model_path: None,
        language,
    };

    // whisper-cli is a blocking subprocess; offload off the Tauri
    // runtime so other IPC commands stay responsive while the
    // transcription runs.
    let result = tauri::async_runtime::spawn_blocking(move || backend.transcribe(&wav_bytes, &opts))
        .await
        .map_err(|e| format!("transcribe task panicked: {e}"))?;

    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_voice_get_settings(
    state: tauri::State<'_, Arc<Store>>,
) -> Result<voice::VoiceSettings, String> {
    voice_settings::load(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_voice_set_settings(
    state: tauri::State<'_, Arc<Store>>,
    patch: voice::VoiceSettingsPatch,
) -> Result<voice::VoiceSettings, String> {
    voice_settings::save(&state, patch).map_err(|e| e.to_string())
}

/// Plain-bytes base64 decoder. Mirrors the in-tree encoder in
/// `voice::base64_encode` so the desktop crate doesn't pull a third-
/// party crate just for one decode call. Tolerates standard alphabet
/// + padding; rejects everything else with a clear error.
fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    fn val(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    let mut buf = [0u8; 4];
    let mut i = 0;
    let mut pad = 0;
    for &b in bytes {
        if b == b'\n' || b == b'\r' || b == b' ' {
            continue;
        }
        if b == b'=' {
            pad += 1;
            buf[i] = 0;
        } else {
            match val(b) {
                Some(v) => buf[i] = v,
                None => return Err(format!("unexpected byte 0x{:02x}", b)),
            }
        }
        i += 1;
        if i == 4 {
            out.push((buf[0] << 2) | (buf[1] >> 4));
            if pad < 2 {
                out.push((buf[1] << 4) | (buf[2] >> 2));
            }
            if pad < 1 {
                out.push((buf[2] << 6) | buf[3]);
            }
            i = 0;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::base64_encode;

    #[test]
    fn b64_round_trip_known_payload() {
        let data = (0u8..32).collect::<Vec<u8>>();
        let encoded = base64_encode(&data);
        let decoded = decode_b64(&encoded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn b64_round_trip_handles_padding() {
        for n in 1..16 {
            let data: Vec<u8> = (0u8..n as u8).collect();
            let encoded = base64_encode(&data);
            let decoded = decode_b64(&encoded).unwrap();
            assert_eq!(decoded, data);
        }
    }

    #[test]
    fn b64_rejects_garbage() {
        assert!(decode_b64("###").is_err());
    }

    #[test]
    fn b64_tolerates_whitespace() {
        let data = b"hello".to_vec();
        let encoded = base64_encode(&data);
        let mut padded = String::new();
        for c in encoded.chars() {
            padded.push(c);
            padded.push('\n');
        }
        let decoded = decode_b64(&padded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn audio_fmt_deserializes_wav() {
        let parsed: AudioFmt = serde_json::from_str("\"wav\"").unwrap();
        assert!(matches!(parsed, AudioFmt::Wav));
    }
}
