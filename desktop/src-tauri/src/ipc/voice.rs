//! v0.3 S5 — voice TTS Tauri commands.
//!
//! Three commands:
//!   - [`voice_synthesize`] — text + voice id → WAV bytes (base64
//!     encoded for IPC transport). Frontend wraps the bytes in a
//!     `Blob` and plays via `HTMLAudioElement`.
//!   - [`voice_list_voices`] — registry surface for the Settings UI
//!     (lets users pick a default voice + see download sizes).
//!   - [`voice_status`] — reports whether Piper + voice models are
//!     installed yet, so the UI can render an "Install Piper" CTA
//!     before the toggle is flipped.
//!
//! Heavy-data IPC rule still applies — voice clips are short (≤ 30s
//! cap from the synth path, ≤ a few hundred KB), well below the 100KB
//! diff limit's spirit.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::voice::{
    self, models, piper, SynthesizeRequest,
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
