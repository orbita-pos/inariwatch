//! v0.3 S5 — Piper TTS subprocess wrapper.
//!
//! Calls the user-installed `piper` binary out-of-process and pipes the
//! returned WAV bytes back. Goes out of process — not via piper-rs
//! crate or `ort` — for two reasons:
//!
//!   1. **No new heavy Cargo deps.** piper-rs / ort would add a couple
//!      of megabytes of Rust deps + onnxruntime build cost on a dev box
//!      that's already tight on disk (see `project_machine_constraints`).
//!   2. **Optional install.** The Piper binary is downloaded by the
//!      user on first opt-in via Settings → AI Preferences. Until then,
//!      `voice::synthesize` falls back to the synthetic WAV in
//!      [`super::wav`]. Subprocess wrapping makes "binary missing"
//!      indistinguishable from "binary failed" — both surface as
//!      `PiperUnavailable` and trigger the synthetic fallback.
//!
//! The wrapper is deliberately thin — it spawns piper, writes the
//! input to stdin, captures stdout (WAV bytes) + stderr, returns. No
//! caching of subprocesses, no bidirectional streaming. Alert TTS is
//! short enough (<5s) that the per-call overhead of `Command::spawn`
//! (~30ms) is negligible.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use thiserror::Error;

use super::models::VoiceModel;

#[derive(Debug, Error)]
pub enum PiperError {
    #[error("piper binary not found at {path}")]
    BinaryMissing { path: String },
    #[error("voice model file not found at {path}")]
    ModelMissing { path: String },
    #[error("piper exited with status {status}: {stderr}")]
    NonZeroExit { status: i32, stderr: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("piper output is not a valid WAV (got {0} bytes, expected ≥ 44)")]
    InvalidWav(usize),
}

/// Resolve where Piper expects to find its model files. The download
/// manager (future session) populates this directory; until then it
/// stays empty and synth falls back to [`super::wav`].
pub fn voice_models_dir(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join("inari-live").join("voice-models")
}

/// Resolve where the Piper binary lives. We check the same dir as the
/// models — keeps the lifecycle in one place. `piper.exe` on Windows,
/// `piper` elsewhere.
pub fn piper_binary_path(app_local_data_dir: &Path) -> PathBuf {
    let bin = if cfg!(target_os = "windows") {
        "piper.exe"
    } else {
        "piper"
    };
    voice_models_dir(app_local_data_dir).join(bin)
}

/// Synthesize `text` with the given voice. `app_local_data_dir` is the
/// app data root (resolve via Tauri's `app_handle().path().app_local_data_dir()`).
/// Returns WAV bytes on success; categorized `PiperError` on failure.
///
/// `speed` is the rate multiplier passed via `--length-scale 1/speed`.
/// 1.0 = nominal; 0.8 = slightly slower; 1.2 = slightly faster. Clamps
/// to [0.5, 2.0] to keep prosody intelligible.
pub fn synthesize(
    app_local_data_dir: &Path,
    text: &str,
    voice: &VoiceModel,
    speed: f32,
) -> Result<Vec<u8>, PiperError> {
    let binary = piper_binary_path(app_local_data_dir);
    if !binary.exists() {
        return Err(PiperError::BinaryMissing {
            path: binary.display().to_string(),
        });
    }
    let model_path = voice_models_dir(app_local_data_dir)
        .join(format!("{}.onnx", voice.voice_id));
    if !model_path.exists() {
        return Err(PiperError::ModelMissing {
            path: model_path.display().to_string(),
        });
    }

    let length_scale = (1.0 / speed.clamp(0.5, 2.0)).to_string();

    let mut child = Command::new(&binary)
        .arg("--model")
        .arg(&model_path)
        .arg("--output_raw")
        .arg("--length_scale")
        .arg(length_scale)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
        stdin.write_all(b"\n")?;
    }

    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(PiperError::NonZeroExit {
            status: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    if output.stdout.len() < 44 {
        return Err(PiperError::InvalidWav(output.stdout.len()));
    }
    Ok(output.stdout)
}

/// Quick check — does the Piper binary look installed at the expected
/// path? Lets the Settings UI surface "Install Piper" before the user
/// flips the toggle.
pub fn binary_installed(app_local_data_dir: &Path) -> bool {
    piper_binary_path(app_local_data_dir).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn voice_models_dir_is_under_inari_live() {
        let tmp = TempDir::new().unwrap();
        let dir = voice_models_dir(tmp.path());
        let s = dir.display().to_string();
        assert!(s.ends_with("voice-models") || s.ends_with("voice-models\\")
                 || s.contains("voice-models"));
        assert!(s.contains("inari-live"));
    }

    #[test]
    fn piper_binary_path_is_os_specific() {
        let tmp = TempDir::new().unwrap();
        let p = piper_binary_path(tmp.path());
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if cfg!(target_os = "windows") {
            assert_eq!(name, "piper.exe");
        } else {
            assert_eq!(name, "piper");
        }
    }

    #[test]
    fn synthesize_errors_when_binary_missing() {
        let tmp = TempDir::new().unwrap();
        let voice = super::super::models::default_voice();
        let res = synthesize(tmp.path(), "hello", voice, 1.0);
        assert!(matches!(res, Err(PiperError::BinaryMissing { .. })));
    }

    #[test]
    fn synthesize_errors_when_model_missing() {
        let tmp = TempDir::new().unwrap();
        // Create just the binary file so we get past the BinaryMissing
        // check and trip the ModelMissing check instead.
        let voice = super::super::models::default_voice();
        let dir = voice_models_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(piper_binary_path(tmp.path()), b"#!/bin/sh\nexit 0\n").unwrap();
        let res = synthesize(tmp.path(), "hello", voice, 1.0);
        assert!(matches!(res, Err(PiperError::ModelMissing { .. })));
    }

    #[test]
    fn binary_installed_reads_filesystem() {
        let tmp = TempDir::new().unwrap();
        assert!(!binary_installed(tmp.path()));
        let dir = voice_models_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(piper_binary_path(tmp.path()), b"x").unwrap();
        assert!(binary_installed(tmp.path()));
    }
}
