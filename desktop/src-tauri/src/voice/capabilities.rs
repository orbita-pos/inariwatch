//! S9 — voice capabilities probe.
//!
//! Surfaces a `VoiceCapabilities` snapshot to the Settings UI so the
//! "Voice input / output" toggles can be gated on real binary +
//! model presence rather than a blind opt-in.
//!
//! Detection rules:
//!   - `stt_available` — `whisper-cli` resolves on PATH (via the
//!     `which` crate, already a runtime dep from Sesión 10's substrate
//!     wrapper).
//!   - `whisper_model_present` — a file exists at
//!     `<inari_voice_dir>/models/ggml-base.en.bin`. The path is
//!     conventional (matches whisper.cpp's release archive layout)
//!     and the user populates it manually per
//!     [`VoiceModelInstallHint`] in Settings.
//!   - `tts_available` — Piper binary is on disk in the
//!     `<app_local_data_dir>/inari-live/voice-models/` directory the
//!     v0.3 S5 surface put it. Mirrors `voice::piper::binary_installed`
//!     so the two probes never contradict each other.
//!   - `piper_model_present` — at least one `.onnx` voice model from
//!     the registry has been downloaded into the same directory.
//!
//! Detection is read-only and side-effect free — it never spawns a
//! subprocess. Probing via `--version` would burn 30 ms per Settings
//! mount on a cold cache and noise up `tracing` for nothing.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{models, piper};

/// User-visible health snapshot for the Voice surface. The frontend
/// renders ✓/✗ chips off this and surfaces install hints when any
/// flag is false.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceCapabilities {
    /// `whisper-cli` resolves on PATH.
    pub stt_available: bool,
    /// Resolved absolute path to `whisper-cli`, or empty when missing.
    /// Surfaced in the UI so users can spot a stale shadow on PATH.
    pub stt_binary_path: String,
    /// Whisper model file exists at the conventional path.
    pub whisper_model_present: bool,
    /// Resolved absolute path the UI prints in install hints (whether
    /// or not the file exists yet).
    pub whisper_model_path: String,
    /// Piper binary is on disk in the v0.3 S5 voice-models directory.
    pub tts_available: bool,
    /// At least one Piper `.onnx` voice model has been downloaded.
    pub piper_model_present: bool,
}

/// Conventional directory under the user home — `~/.inari/voice/`.
/// `models/` and `tmp/` live below this. `dirs::home_dir()` is in the
/// runtime dep set already; on the (extremely rare) machine where it
/// resolves to `None` we fall back to the app-local data dir so STT
/// degrades gracefully rather than panics.
pub fn voice_root_dir(home: Option<&Path>, app_local_data_dir: &Path) -> PathBuf {
    match home {
        Some(h) => h.join(".inari").join("voice"),
        None => app_local_data_dir.join("inari-live").join("voice"),
    }
}

/// Default whisper model path — mirrors the layout users get from
/// extracting whisper.cpp's release archive into `models/`.
pub fn default_whisper_model_path(home: Option<&Path>, app_local_data_dir: &Path) -> PathBuf {
    voice_root_dir(home, app_local_data_dir)
        .join("models")
        .join("ggml-base.en.bin")
}

/// Tmp dir for transcription scratch WAVs. STT writes UUID-named files
/// here, never accepts caller-supplied paths.
pub fn voice_tmp_dir(home: Option<&Path>, app_local_data_dir: &Path) -> PathBuf {
    voice_root_dir(home, app_local_data_dir).join("tmp")
}

/// Probe the system for voice capabilities. `app_local_data_dir` is
/// the Tauri `app_local_data_dir()`; `home` is the resolved user home
/// (`dirs::home_dir()`) — passed in so tests can inject a TempDir.
pub fn detect(home: Option<&Path>, app_local_data_dir: &Path) -> VoiceCapabilities {
    let (stt_available, stt_binary_path) = match which::which("whisper-cli") {
        Ok(p) => (true, p.display().to_string()),
        Err(_) => (false, String::new()),
    };

    let whisper_model = default_whisper_model_path(home, app_local_data_dir);
    let whisper_model_present = whisper_model.exists();
    let whisper_model_path = whisper_model.display().to_string();

    let tts_available = piper::binary_installed(app_local_data_dir);

    // Piper model presence: any registered `.onnx` file landed.
    let voices_dir = piper::voice_models_dir(app_local_data_dir);
    let piper_model_present = models::VOICE_REGISTRY
        .iter()
        .any(|v| voices_dir.join(format!("{}.onnx", v.voice_id)).exists());

    VoiceCapabilities {
        stt_available,
        stt_binary_path,
        whisper_model_present,
        whisper_model_path,
        tts_available,
        piper_model_present,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn voice_root_uses_home_when_provided() {
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let root = voice_root_dir(Some(home.path()), app.path());
        assert!(root.starts_with(home.path()));
        assert!(root.ends_with(Path::new(".inari").join("voice")));
    }

    #[test]
    fn voice_root_falls_back_to_app_local_when_home_missing() {
        let app = TempDir::new().unwrap();
        let root = voice_root_dir(None, app.path());
        assert!(root.starts_with(app.path()));
        assert!(root.ends_with(Path::new("inari-live").join("voice")));
    }

    #[test]
    fn default_whisper_model_path_is_conventional() {
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let p = default_whisper_model_path(Some(home.path()), app.path());
        assert!(p.ends_with("ggml-base.en.bin"));
        assert!(p.parent().unwrap().ends_with("models"));
    }

    #[test]
    fn voice_tmp_dir_is_under_voice_root() {
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let tmp = voice_tmp_dir(Some(home.path()), app.path());
        assert!(tmp.ends_with("tmp"));
        assert!(tmp.starts_with(home.path()));
    }

    #[test]
    fn detect_reports_missing_when_nothing_installed() {
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let caps = detect(Some(home.path()), app.path());
        // STT availability depends on the host PATH, so we don't pin
        // it; everything else is filesystem-only and must be false on
        // a fresh TempDir.
        assert!(!caps.whisper_model_present);
        assert!(!caps.tts_available);
        assert!(!caps.piper_model_present);
        assert!(!caps.whisper_model_path.is_empty());
    }

    #[test]
    fn detect_picks_up_piper_binary() {
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let voices_dir = piper::voice_models_dir(app.path());
        fs::create_dir_all(&voices_dir).unwrap();
        let bin = piper::piper_binary_path(app.path());
        fs::write(&bin, b"x").unwrap();
        let caps = detect(Some(home.path()), app.path());
        assert!(caps.tts_available);
    }

    #[test]
    fn detect_picks_up_piper_model() {
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let voices_dir = piper::voice_models_dir(app.path());
        fs::create_dir_all(&voices_dir).unwrap();
        // Drop one of the registered voices into the dir.
        let v = &models::VOICE_REGISTRY[0];
        fs::write(voices_dir.join(format!("{}.onnx", v.voice_id)), b"x").unwrap();
        let caps = detect(Some(home.path()), app.path());
        assert!(caps.piper_model_present);
    }

    #[test]
    fn detect_picks_up_whisper_model() {
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        let model = default_whisper_model_path(Some(home.path()), app.path());
        fs::create_dir_all(model.parent().unwrap()).unwrap();
        fs::write(&model, b"x").unwrap();
        let caps = detect(Some(home.path()), app.path());
        assert!(caps.whisper_model_present);
        assert_eq!(caps.whisper_model_path, model.display().to_string());
    }

    #[test]
    fn capabilities_round_trips_through_serde() {
        let caps = VoiceCapabilities {
            stt_available: true,
            stt_binary_path: "/usr/local/bin/whisper-cli".to_string(),
            whisper_model_present: true,
            whisper_model_path: "/home/me/.inari/voice/models/ggml-base.en.bin".to_string(),
            tts_available: false,
            piper_model_present: false,
        };
        let json = serde_json::to_string(&caps).unwrap();
        let parsed: VoiceCapabilities = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, caps);
    }
}
