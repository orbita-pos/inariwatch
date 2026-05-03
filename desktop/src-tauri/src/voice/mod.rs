//! v0.3 S5 — voice TTS surface.
//!
//! Per `INARI_AI_ARCHITECTURE.md` §5.4 + the v0.3 S5 brief: voice
//! synthesis runs LOCALLY on Inari Live (Piper) when the workspace
//! flag `localVoiceEnabled` is on. Cloud fallback is OpenAI tts-1
//! (handled by web's notify dispatcher, not this module).
//!
//! This module exposes one entry point — [`synthesize`] — that the
//! relay dispatcher (`relay_client::handle_dispatch`) and the Tauri
//! frontend (`voice_synthesize` command) both call. It picks the
//! voice from the registry, tries Piper first, and falls back to a
//! synthetic WAV when Piper isn't installed yet. Either way the
//! caller gets back a valid WAV byte buffer + the voice id used.
//!
//! ## Pipeline
//!
//! ```text
//!   request (text, voice_id, speed)
//!         │
//!         ▼
//!   models::lookup(voice_id) ── default if unknown ──┐
//!         │                                          │
//!         ▼                                          ▼
//!   piper::synthesize(...)  ──── on missing ────►  wav::synthetic_speech_wav(text)
//!         │                                          │
//!         ▼                                          ▼
//!                       Vec<u8>  (valid WAV header + body)
//! ```
//!
//! ## What this module does NOT do
//!
//! - It does not download voice models. That's a future-session UI
//!   surface; the URLs/sizes live in [`models::VOICE_REGISTRY`].
//! - It does not own the Tauri command registration; see `lib.rs`.
//! - It does not play the audio. Frontend feeds bytes to
//!   `HTMLAudioElement` via a Blob URL.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod models;
pub mod piper;
pub mod wav;

#[cfg(test)]
mod tests;

pub use models::{VoiceModel, VoiceQuality, VOICE_REGISTRY};

/// Synthesis fallback path that was actually used. Surface this in
/// receipts + telemetry so the eval harness can tell at a glance
/// whether Piper actually ran or whether the synthetic WAV stood in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SynthEngine {
    /// Real Piper subprocess produced the bytes.
    Piper,
    /// Synthetic WAV (silent or shaped tone) — Piper not available.
    SyntheticFallback,
}

impl SynthEngine {
    pub fn as_str(&self) -> &'static str {
        match self {
            SynthEngine::Piper => "piper",
            SynthEngine::SyntheticFallback => "synthetic_fallback",
        }
    }
}

#[derive(Debug, Error)]
pub enum VoiceError {
    #[error("text is empty")]
    EmptyText,
    #[error("text exceeds 4096 chars (got {0})")]
    TextTooLong(usize),
}

/// Outbound request shape — mirrors the dispatch frame payload that
/// `notify_compose` builds on the cloud side.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SynthesizeRequest {
    pub text: String,
    /// Pinning a voice id is recommended; default is en_US-amy-medium.
    #[serde(default)]
    pub voice_id: Option<String>,
    /// Rate multiplier 0.5..=2.0. Defaults to 1.0.
    #[serde(default = "default_speed")]
    pub speed: f32,
}

fn default_speed() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SynthesizeResult {
    pub audio_wav: Vec<u8>,
    pub voice_id: String,
    pub engine: SynthEngine,
    /// Approximate audio duration in milliseconds. Computed from the
    /// WAV header so callers don't re-parse to display it.
    pub duration_ms: u32,
}

/// Maximum input length — 4096 chars matches OpenAI's tts-1 endpoint
/// and gives the cloud fallback a clean parity. Anything longer should
/// be split by the caller.
pub const MAX_TEXT_CHARS: usize = 4096;

/// Synthesize an audio buffer. `app_local_data_dir` is the Tauri
/// `app_local_data_dir()` (where Piper + voice models live in
/// `<dir>/inari-live/voice-models/`). `request.voice_id == None` falls
/// back to [`models::default_voice`].
pub fn synthesize(
    app_local_data_dir: &Path,
    request: SynthesizeRequest,
) -> Result<SynthesizeResult, VoiceError> {
    let trimmed = request.text.trim();
    if trimmed.is_empty() {
        return Err(VoiceError::EmptyText);
    }
    if trimmed.chars().count() > MAX_TEXT_CHARS {
        return Err(VoiceError::TextTooLong(trimmed.chars().count()));
    }

    let voice = match request.voice_id.as_deref() {
        Some(id) => models::lookup(id).unwrap_or_else(|| {
            tracing::warn!(
                voice_id = id,
                "[voice] unknown voice id; falling back to default"
            );
            models::default_voice()
        }),
        None => models::default_voice(),
    };

    // Try Piper first; on any error, synth a plausible WAV so the
    // pipeline always returns audio bytes. The error is logged but
    // never surfaced to the dispatcher — voice notifications are
    // best-effort.
    let (audio_wav, engine) =
        match piper::synthesize(app_local_data_dir, trimmed, voice, request.speed) {
            Ok(bytes) => (bytes, SynthEngine::Piper),
            Err(err) => {
                tracing::info!(
                    error = %err,
                    voice_id = voice.voice_id,
                    "[voice] piper unavailable; using synthetic WAV"
                );
                (wav::synthetic_speech_wav(trimmed), SynthEngine::SyntheticFallback)
            }
        };

    let duration_ms = approx_duration_ms_from_wav(&audio_wav);
    Ok(SynthesizeResult {
        audio_wav,
        voice_id: voice.voice_id.to_string(),
        engine,
        duration_ms,
    })
}

/// Pull duration from a PCM_INT16 WAV header (`data` subchunk size
/// divided by byte-rate). Returns 0 if the header is malformed —
/// callers should never see a malformed header from our own synth.
fn approx_duration_ms_from_wav(wav: &[u8]) -> u32 {
    if wav.len() < 44 {
        return 0;
    }
    if &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return 0;
    }
    let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
    let bits = u16::from_le_bytes([wav[34], wav[35]]);
    let channels = u16::from_le_bytes([wav[22], wav[23]]);
    let data_size = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]);
    let bytes_per_second = rate * (bits as u32 / 8) * (channels as u32);
    if bytes_per_second == 0 {
        return 0;
    }
    (data_size as u64 * 1000 / bytes_per_second as u64) as u32
}

// ── Relay handler glue ─────────────────────────────────────────────────────

/// Handler invoked by `relay_client::handle_dispatch` for the
/// `voice.tts.alert` and `voice.tts.digest` tasks. Reads the
/// SynthesizeRequest off the dispatch payload, runs `synthesize`, and
/// returns a JSON-serializable result. The caller wraps it in the
/// outbound relay response frame.
pub fn handle_voice_tts_dispatch(
    app_local_data_dir: Arc<std::path::PathBuf>,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req: SynthesizeRequest = serde_json::from_value(payload.clone())
        .map_err(|e| format!("invalid voice payload: {}", e))?;
    let res = synthesize(&app_local_data_dir, req).map_err(|e| e.to_string())?;
    // The audio bytes are base64-encoded for transport over JSON. The
    // web side decodes via Buffer.from(b64, 'base64') before persisting.
    let b64 = base64_encode(&res.audio_wav);
    Ok(serde_json::json!({
        "audio_wav_b64": b64,
        "voice_id": res.voice_id,
        "engine": res.engine.as_str(),
        "duration_ms": res.duration_ms,
        "audio_format": "wav",
        "sample_rate_hz": wav::SAMPLE_RATE_HZ,
    }))
}

/// Tiny in-tree base64 encoder (Standard alphabet, with padding) so
/// `voice` doesn't pull a third-party crate just for this. Mirrors the
/// minimal encoder pattern used elsewhere in the desktop crate. Output
/// is web-decodable via `Buffer.from(s, 'base64')` / `atob`.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPH: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16)
            | ((bytes[i + 1] as u32) << 8)
            | (bytes[i + 2] as u32);
        out.push(ALPH[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPH[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPH[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(ALPH[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPH[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}
