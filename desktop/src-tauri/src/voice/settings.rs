//! S9 — voice settings persistence.
//!
//! Mirrors the pattern in `crate::ipc::settings` for the other Settings
//! sub-tabs: every flag is stored as its own row in the SQL `settings`
//! KV table (migration 0001), values serialized as strings. No per-
//! section schema, no migration needed.
//!
//! Defaults are deliberately conservative — voice mode is opt-in.
//! `input_enabled` and `output_enabled` both default to `false`, and
//! `auto_speak_responses` is gated behind the latter even when it
//! reads `true` so a stale config can never cause unsolicited audio.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::store::{settings as kv, Store};

use crate::ipc::error::IpcError;

const KEY_INPUT_ENABLED: &str = "voice_input_enabled";
const KEY_OUTPUT_ENABLED: &str = "voice_output_enabled";
const KEY_STT_MODEL_PATH: &str = "voice_stt_model_path";
const KEY_TTS_VOICE: &str = "voice_tts_voice_id";
const KEY_AUTO_SPEAK: &str = "voice_auto_speak_responses";
const KEY_PUSH_TO_TALK: &str = "voice_push_to_talk";

/// User-facing voice settings. The frontend reads/writes the full
/// snapshot through a single round-trip — settings are tiny, partial
/// patches aren't worth the surface-area cost.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct VoiceSettings {
    /// Master toggle for STT (mic button rendered in chat input).
    pub input_enabled: bool,
    /// Master toggle for TTS (auto-speak surface enabled).
    pub output_enabled: bool,
    /// Override the default whisper model path. Empty = use default.
    pub stt_model_path: String,
    /// Selected Piper voice id. Empty = use registry default.
    pub tts_voice: String,
    /// When `output_enabled` is true, automatically speak assistant
    /// responses. Independent flag so users can keep the surface
    /// available (Test speak, manual playback) without auto-firing.
    pub auto_speak_responses: bool,
    /// Push-to-talk mode (hold mic button) vs click-toggle hands-free.
    pub push_to_talk: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            input_enabled: false,
            output_enabled: false,
            stt_model_path: String::new(),
            tts_voice: String::new(),
            auto_speak_responses: false,
            push_to_talk: true,
        }
    }
}

/// Patch shape accepted from the IPC layer. Each field is an `Option`
/// — `None` keeps the prior value. Mirrors the `*Patch` types in
/// `crate::ipc::settings`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct VoiceSettingsPatch {
    pub input_enabled: Option<bool>,
    pub output_enabled: Option<bool>,
    pub stt_model_path: Option<String>,
    pub tts_voice: Option<String>,
    pub auto_speak_responses: Option<bool>,
    pub push_to_talk: Option<bool>,
}

/// Read the current snapshot. Missing keys fall back to defaults.
pub fn load(store: &Arc<Store>) -> Result<VoiceSettings, IpcError> {
    let d = VoiceSettings::default();
    Ok(VoiceSettings {
        input_enabled: read_bool_or(store, KEY_INPUT_ENABLED, d.input_enabled)?,
        output_enabled: read_bool_or(store, KEY_OUTPUT_ENABLED, d.output_enabled)?,
        stt_model_path: read_string_or(store, KEY_STT_MODEL_PATH, &d.stt_model_path)?,
        tts_voice: read_string_or(store, KEY_TTS_VOICE, &d.tts_voice)?,
        auto_speak_responses: read_bool_or(store, KEY_AUTO_SPEAK, d.auto_speak_responses)?,
        push_to_talk: read_bool_or(store, KEY_PUSH_TO_TALK, d.push_to_talk)?,
    })
}

/// Apply a patch and return the resulting snapshot.
pub fn save(store: &Arc<Store>, patch: VoiceSettingsPatch) -> Result<VoiceSettings, IpcError> {
    if let Some(b) = patch.input_enabled {
        kv::set(store, KEY_INPUT_ENABLED, &b.to_string())?;
    }
    if let Some(b) = patch.output_enabled {
        kv::set(store, KEY_OUTPUT_ENABLED, &b.to_string())?;
    }
    if let Some(p) = patch.stt_model_path {
        // Empty string deletes — matches the convention in
        // ipc::settings::apply_optional_string.
        let trimmed = p.trim();
        if trimmed.is_empty() {
            kv::delete(store, KEY_STT_MODEL_PATH)?;
        } else {
            kv::set(store, KEY_STT_MODEL_PATH, trimmed)?;
        }
    }
    if let Some(v) = patch.tts_voice {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            kv::delete(store, KEY_TTS_VOICE)?;
        } else {
            kv::set(store, KEY_TTS_VOICE, trimmed)?;
        }
    }
    if let Some(b) = patch.auto_speak_responses {
        kv::set(store, KEY_AUTO_SPEAK, &b.to_string())?;
    }
    if let Some(b) = patch.push_to_talk {
        kv::set(store, KEY_PUSH_TO_TALK, &b.to_string())?;
    }
    load(store)
}

fn read_string_or(store: &Store, key: &str, fallback: &str) -> Result<String, IpcError> {
    Ok(kv::get(store, key)?
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_string()))
}

fn read_bool_or(store: &Store, key: &str, fallback: bool) -> Result<bool, IpcError> {
    Ok(match kv::get(store, key)?.as_deref() {
        Some("true") | Some("1") | Some("yes") => true,
        Some("false") | Some("0") | Some("no") => false,
        _ => fallback,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_all_off() {
        let d = VoiceSettings::default();
        assert!(!d.input_enabled);
        assert!(!d.output_enabled);
        assert!(!d.auto_speak_responses);
        assert!(d.stt_model_path.is_empty());
        assert!(d.tts_voice.is_empty());
        // Push-to-talk is on by default — safer interaction model than
        // hands-free for an opt-in feature.
        assert!(d.push_to_talk);
    }

    #[test]
    fn round_trips_through_serde() {
        let s = VoiceSettings {
            input_enabled: true,
            output_enabled: true,
            stt_model_path: "/Users/x/.inari/voice/models/foo.bin".to_string(),
            tts_voice: "en_US-amy-medium".to_string(),
            auto_speak_responses: true,
            push_to_talk: false,
        };
        let json = serde_json::to_string(&s).unwrap();
        let parsed: VoiceSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, s);
    }

    #[test]
    fn patch_deserializes_with_missing_fields_as_none() {
        let json = r#"{"input_enabled": true}"#;
        let patch: VoiceSettingsPatch = serde_json::from_str(json).unwrap();
        assert_eq!(patch.input_enabled, Some(true));
        assert_eq!(patch.output_enabled, None);
        assert_eq!(patch.stt_model_path, None);
        assert_eq!(patch.tts_voice, None);
        assert_eq!(patch.auto_speak_responses, None);
        assert_eq!(patch.push_to_talk, None);
    }

    #[test]
    fn patch_empty_object_is_all_none() {
        let patch: VoiceSettingsPatch = serde_json::from_str("{}").unwrap();
        assert!(patch.input_enabled.is_none());
        assert!(patch.output_enabled.is_none());
        assert!(patch.stt_model_path.is_none());
        assert!(patch.tts_voice.is_none());
        assert!(patch.auto_speak_responses.is_none());
        assert!(patch.push_to_talk.is_none());
    }
}
