//! S9 — Whisper STT backend.
//!
//! `WhisperBackend` is the trait the IPC layer drives; the production
//! implementation is `WhisperCliBackend`, which shells out to the
//! `whisper-cli` binary on the user's PATH (the same binary the
//! whisper.cpp release archive ships).
//!
//! ## Audio format contract
//!
//! `transcribe` accepts WAV bytes — 16 kHz mono PCM, the format
//! whisper-cli expects. The frontend records via `MediaRecorder`,
//! decodes the resulting `audio/webm;codecs=opus` blob through
//! `AudioContext.decodeAudioData`, resamples to 16 kHz mono in an
//! `OfflineAudioContext`, and serializes a fresh WAV buffer
//! client-side. The backend therefore needs no Opus / WebM decoder of
//! its own — symphonia 0.5 ships pre-Opus, and adding `audiopus` (a
//! libopus binding) would drag a C build into the desktop crate.
//! Browser-side transcoding sidesteps that entirely.
//!
//! If the caller passes non-WAV bytes the backend errors out without
//! invoking the subprocess, so a misconfigured frontend can't
//! masquerade as garbage audio to whisper-cli.
//!
//! ## Sandbox / argv discipline (S4 spirit)
//!
//! The S4 local-exec sandbox locked `Command::new(prog).arg(arg)…` as
//! the only shell-spawning idiom in the desktop crate (no `sh -c`, no
//! `cmd /c`, no string interpolation). `WhisperCliBackend` follows
//! the same argv-only discipline: every argument is passed through
//! `Command::arg`, never concatenated. The scratch WAV path is a
//! UUID v4 inside `<voice_root>/tmp/`, never accepts caller-supplied
//! filenames.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

use super::capabilities;

/// Caller-tuneable transcription options. Matches the subset of
/// whisper-cli flags the IPC + Settings surface expose.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TranscribeOpts {
    /// Path to the whisper model (`ggml-*.bin`). When `None`, the
    /// backend resolves the conventional default
    /// `~/.inari/voice/models/ggml-base.en.bin`.
    pub model_path: Option<PathBuf>,
    /// BCP-47 / whisper language code (e.g. `en`, `es`, `auto`).
    /// Defaults to `en` to match the bundled `.en` model.
    pub language: Option<String>,
}

/// Successful transcription result. The `engine` field is surfaced so
/// telemetry / receipts can tell at a glance whether a real Whisper
/// run produced the text or a mock did (test paths).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct TranscriptionResult {
    pub text: String,
    /// `whisper_cli` for the production path, `mock` for tests.
    pub engine: String,
    /// Approximate audio length in milliseconds (parsed from the WAV
    /// header). Surfaced in the UI alongside the transcript.
    pub audio_duration_ms: u32,
}

#[derive(Debug, Error)]
pub enum TranscribeError {
    #[error("audio bytes are not a valid WAV (got {0} bytes)")]
    InvalidWav(usize),
    #[error("whisper-cli binary not found on PATH — install whisper.cpp first")]
    BinaryMissing,
    #[error("whisper model not found at {path}")]
    ModelMissing { path: String },
    #[error("whisper-cli exited with status {status}: {stderr}")]
    NonZeroExit { status: i32, stderr: String },
    #[error("whisper-cli wrote no transcript file at {path}")]
    NoTranscript { path: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Backend interface for STT. Synchronous because whisper-cli is a
/// blocking subprocess; the IPC layer wraps the call in
/// `tokio::task::spawn_blocking` so the Tauri runtime stays cooperative.
pub trait WhisperBackend: Send + Sync {
    fn transcribe(
        &self,
        wav_bytes: &[u8],
        opts: &TranscribeOpts,
    ) -> Result<TranscriptionResult, TranscribeError>;
}

/// Production backend — shells out to `whisper-cli`. The binary is
/// resolved from PATH at construction time so a misconfigured machine
/// fails fast (the IPC layer catches the error and returns it to the
/// frontend, which renders the install hint).
pub struct WhisperCliBackend {
    /// Resolved path to `whisper-cli`. Captured at construction so we
    /// don't re-`which` on every call.
    binary: PathBuf,
    /// Where scratch WAV + transcript files live. Resolved against
    /// `dirs::home_dir()` + `app_local_data_dir` per
    /// `capabilities::voice_tmp_dir`.
    tmp_dir: PathBuf,
    /// Default model path used when `TranscribeOpts::model_path` is
    /// `None`. Resolved at construction for the same reason as
    /// `binary`.
    default_model: PathBuf,
    /// Override for the binary spawned by `transcribe`. Tests inject
    /// a fake script via [`with_binary`]. Production callers leave
    /// it unset and the resolved PATH binary wins.
    binary_override: Option<PathBuf>,
}

impl WhisperCliBackend {
    /// Build a backend resolving paths against the conventional dirs.
    /// Returns `None` when whisper-cli isn't installed — the IPC layer
    /// surfaces that as `TranscribeError::BinaryMissing`.
    pub fn from_dirs(home: Option<&Path>, app_local_data_dir: &Path) -> Option<Self> {
        let binary = which::which("whisper-cli").ok()?;
        let tmp_dir = capabilities::voice_tmp_dir(home, app_local_data_dir);
        let default_model = capabilities::default_whisper_model_path(home, app_local_data_dir);
        Some(Self {
            binary,
            tmp_dir,
            default_model,
            binary_override: None,
        })
    }

    /// Test-only constructor — bypasses PATH resolution and skips the
    /// "binary exists" precondition the runtime constructor enforces.
    /// Lives behind `#[cfg(test)]` so production code can never reach
    /// for it.
    #[cfg(test)]
    pub fn with_binary(binary: PathBuf, tmp_dir: PathBuf, default_model: PathBuf) -> Self {
        Self {
            binary,
            tmp_dir,
            default_model,
            binary_override: None,
        }
    }
}

impl WhisperBackend for WhisperCliBackend {
    fn transcribe(
        &self,
        wav_bytes: &[u8],
        opts: &TranscribeOpts,
    ) -> Result<TranscriptionResult, TranscribeError> {
        if !is_valid_wav(wav_bytes) {
            return Err(TranscribeError::InvalidWav(wav_bytes.len()));
        }

        // Resolve which binary to spawn. Tests can swap the path via
        // `binary_override`; production keeps the resolved PATH binary.
        let bin = self.binary_override.as_ref().unwrap_or(&self.binary);
        if !bin.exists() {
            return Err(TranscribeError::BinaryMissing);
        }

        let model = match &opts.model_path {
            Some(p) => p.clone(),
            None => self.default_model.clone(),
        };
        if !model.exists() {
            return Err(TranscribeError::ModelMissing {
                path: model.display().to_string(),
            });
        }

        // Scratch WAV — UUID v4, never caller-supplied. Cleanup is in
        // the `Drop` glue below; if cleanup fails (e.g. the user
        // crashed mid-transcribe) the next run picks up an old file
        // and overwrites it.
        fs::create_dir_all(&self.tmp_dir)?;
        let scratch_id = Uuid::new_v4().to_string();
        let scratch_wav = self.tmp_dir.join(format!("{scratch_id}.wav"));
        // whisper-cli writes its transcript to <input_path>.txt.
        let scratch_txt = self.tmp_dir.join(format!("{scratch_id}.wav.txt"));
        fs::write(&scratch_wav, wav_bytes)?;
        let _guard = ScratchCleanup {
            paths: vec![scratch_wav.clone(), scratch_txt.clone()],
        };

        let language = opts.language.as_deref().unwrap_or("en");

        // argv-only — no shell, no interpolation. Mirrors S4 sandbox.
        // `--output-txt` writes the transcript next to the input as
        // `<input>.txt`. `--no-prints` suppresses progress noise.
        let output = Command::new(bin)
            .arg("--model")
            .arg(&model)
            .arg("--language")
            .arg(language)
            .arg("--output-txt")
            .arg("--no-prints")
            .arg("--file")
            .arg(&scratch_wav)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;

        if !output.status.success() {
            return Err(TranscribeError::NonZeroExit {
                status: output.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }

        if !scratch_txt.exists() {
            return Err(TranscribeError::NoTranscript {
                path: scratch_txt.display().to_string(),
            });
        }

        let raw = fs::read_to_string(&scratch_txt)?;
        let text = raw.trim().to_string();

        Ok(TranscriptionResult {
            text,
            engine: "whisper_cli".to_string(),
            audio_duration_ms: wav_duration_ms(wav_bytes),
        })
    }
}

/// Drop-guard that wipes the scratch WAV + transcript when the
/// transcribe call returns (success or failure). Best-effort — we
/// don't surface a cleanup error because the user already got a
/// terminal result.
struct ScratchCleanup {
    paths: Vec<PathBuf>,
}

impl Drop for ScratchCleanup {
    fn drop(&mut self) {
        for p in &self.paths {
            let _ = fs::remove_file(p);
        }
    }
}

/// Mock backend for tests. Returns a deterministic transcript +
/// engine = "mock" so callers can assert against it without spawning
/// a real subprocess.
#[cfg(test)]
pub struct MockWhisperBackend {
    pub transcript: String,
}

#[cfg(test)]
impl Default for MockWhisperBackend {
    fn default() -> Self {
        Self {
            transcript: "transcript".to_string(),
        }
    }
}

#[cfg(test)]
impl WhisperBackend for MockWhisperBackend {
    fn transcribe(
        &self,
        wav_bytes: &[u8],
        _opts: &TranscribeOpts,
    ) -> Result<TranscriptionResult, TranscribeError> {
        if !is_valid_wav(wav_bytes) {
            return Err(TranscribeError::InvalidWav(wav_bytes.len()));
        }
        Ok(TranscriptionResult {
            text: self.transcript.clone(),
            engine: "mock".to_string(),
            audio_duration_ms: wav_duration_ms(wav_bytes),
        })
    }
}

/// Quick WAV validity check — RIFF + WAVE markers + minimum header
/// length. Does NOT verify the data chunk size matches the buffer
/// (whisper-cli is happy with rough headers as long as the chunk
/// metadata parses).
fn is_valid_wav(bytes: &[u8]) -> bool {
    bytes.len() >= 44 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

/// Duration estimate in ms from a PCM_INT16 WAV header. Mirrors the
/// helper in `voice::approx_duration_ms_from_wav` — duplicated rather
/// than re-exported so the STT module doesn't pull in the synth path.
fn wav_duration_ms(wav: &[u8]) -> u32 {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
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

/// Minimum playable WAV — 44-byte header for 16 kHz mono int16, no
/// audio samples. Used by tests + as a known-good fixture inside the
/// IPC layer when the frontend hasn't sent audio yet.
pub fn empty_wav_16khz_mono() -> Vec<u8> {
    let sample_rate = 16_000u32;
    let channels = 1u16;
    let bits = 16u16;
    let byte_rate = sample_rate * channels as u32 * bits as u32 / 8;
    let block_align = channels * bits / 8;
    let data_size = 0u32;
    let chunk_size = 36 + data_size;

    let mut header = Vec::with_capacity(44);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&chunk_size.to_le_bytes());
    header.extend_from_slice(b"WAVE");
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&16u32.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes());
    header.extend_from_slice(&channels.to_le_bytes());
    header.extend_from_slice(&sample_rate.to_le_bytes());
    header.extend_from_slice(&byte_rate.to_le_bytes());
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&bits.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_size.to_le_bytes());
    header
}

/// Timeout the IPC layer applies to a `transcribe` call. Whisper.cpp
/// runs ~1× real-time on CPU at the `base.en` model size, so a 30 s
/// clip transcribes in ~30 s; we double that to leave headroom for
/// model load on a cold cache. Surfaced as a const so tests + the
/// IPC layer agree on the figure.
pub const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Build a fake whisper-cli at `dir/<name>` that writes a known
    /// transcript next to the input WAV. Cross-platform — emits a
    /// `.cmd` shim on Windows, a shell script elsewhere. The IPC
    /// layer never sees this — it's a test-only helper.
    fn write_fake_whisper_cli(dir: &Path, transcript: &str) -> PathBuf {
        if cfg!(target_os = "windows") {
            // .cmd shim. Parses out `--file <wav>` and writes a `.txt`
            // next to it. `%1..%n` walks the argv. We fish for `--file`
            // and grab the next token.
            let path = dir.join("fake-whisper-cli.cmd");
            let body = format!(
                "@echo off\r\n\
:loop\r\n\
if \"%~1\"==\"\" goto :end\r\n\
if \"%~1\"==\"--file\" (\r\n\
  set \"WAV=%~2\"\r\n\
  echo {transcript}> \"%~2.txt\"\r\n\
  goto :end\r\n\
)\r\n\
shift\r\n\
goto :loop\r\n\
:end\r\n\
exit /b 0\r\n"
            );
            fs::write(&path, body).unwrap();
            path
        } else {
            let path = dir.join("fake-whisper-cli.sh");
            let body = format!(
                "#!/bin/sh\n\
while [ $# -gt 0 ]; do\n\
  case \"$1\" in\n\
    --file)\n\
      printf '%s' '{transcript}' > \"$2.txt\"\n\
      shift 2\n\
      ;;\n\
    *)\n\
      shift\n\
      ;;\n\
  esac\n\
done\n\
exit 0\n"
            );
            fs::write(&path, body).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&path).unwrap().permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&path, perms).unwrap();
            }
            path
        }
    }

    #[test]
    fn empty_wav_passes_validity_check() {
        let wav = empty_wav_16khz_mono();
        assert!(is_valid_wav(&wav));
    }

    #[test]
    fn random_bytes_fail_validity_check() {
        let bytes = vec![0u8; 100];
        assert!(!is_valid_wav(&bytes));
    }

    #[test]
    fn short_buffer_fails_validity_check() {
        assert!(!is_valid_wav(&[0u8; 10]));
    }

    #[test]
    fn mock_returns_canned_transcript() {
        let backend = MockWhisperBackend::default();
        let wav = empty_wav_16khz_mono();
        let res = backend
            .transcribe(&wav, &TranscribeOpts::default())
            .unwrap();
        assert_eq!(res.text, "transcript");
        assert_eq!(res.engine, "mock");
    }

    #[test]
    fn mock_rejects_invalid_wav() {
        let backend = MockWhisperBackend::default();
        let res = backend.transcribe(&[0u8; 5], &TranscribeOpts::default());
        assert!(matches!(res, Err(TranscribeError::InvalidWav(5))));
    }

    #[test]
    fn whisper_cli_backend_runs_fake_binary_end_to_end() {
        // This is the production code path with a fake binary swapped
        // in via the test-only `with_binary` constructor + a model
        // file scribbled into a TempDir.
        let workdir = TempDir::new().unwrap();
        let bin = write_fake_whisper_cli(workdir.path(), "hello world");
        let model_path = workdir.path().join("model.bin");
        fs::write(&model_path, b"fake-model").unwrap();
        let tmp_dir = workdir.path().join("tmp");

        let backend = WhisperCliBackend::with_binary(bin, tmp_dir.clone(), model_path.clone());
        let wav = empty_wav_16khz_mono();
        let res = backend
            .transcribe(&wav, &TranscribeOpts::default())
            .expect("fake whisper-cli succeeds");
        assert_eq!(res.text, "hello world");
        assert_eq!(res.engine, "whisper_cli");
    }

    #[test]
    fn whisper_cli_backend_errors_on_missing_model() {
        let workdir = TempDir::new().unwrap();
        let bin = write_fake_whisper_cli(workdir.path(), "x");
        let nonexistent = workdir.path().join("nope.bin");
        let tmp_dir = workdir.path().join("tmp");
        let backend = WhisperCliBackend::with_binary(bin, tmp_dir, nonexistent);
        let wav = empty_wav_16khz_mono();
        let res = backend.transcribe(&wav, &TranscribeOpts::default());
        assert!(matches!(res, Err(TranscribeError::ModelMissing { .. })));
    }

    #[test]
    fn whisper_cli_backend_errors_on_invalid_wav() {
        let workdir = TempDir::new().unwrap();
        let bin = write_fake_whisper_cli(workdir.path(), "x");
        let model = workdir.path().join("model.bin");
        fs::write(&model, b"x").unwrap();
        let tmp_dir = workdir.path().join("tmp");
        let backend = WhisperCliBackend::with_binary(bin, tmp_dir, model);
        let res = backend.transcribe(&[0u8; 100], &TranscribeOpts::default());
        assert!(matches!(res, Err(TranscribeError::InvalidWav(100))));
    }

    #[test]
    fn from_dirs_returns_none_without_whisper_on_path() {
        // PATH likely doesn't have whisper-cli on a CI box; if it
        // does, this test skips itself rather than failing.
        if which::which("whisper-cli").is_ok() {
            return;
        }
        let home = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        assert!(WhisperCliBackend::from_dirs(Some(home.path()), app.path()).is_none());
    }

    #[test]
    fn scratch_files_are_cleaned_up_after_transcribe() {
        let workdir = TempDir::new().unwrap();
        let bin = write_fake_whisper_cli(workdir.path(), "abc");
        let model = workdir.path().join("model.bin");
        fs::write(&model, b"x").unwrap();
        let tmp_dir = workdir.path().join("tmp");
        let backend = WhisperCliBackend::with_binary(bin, tmp_dir.clone(), model);
        let wav = empty_wav_16khz_mono();
        backend.transcribe(&wav, &TranscribeOpts::default()).unwrap();
        // After return: tmp_dir exists but contains no scratch
        // *.wav / *.txt files (drop guard wiped them).
        let count = fs::read_dir(&tmp_dir)
            .map(|it| it.count())
            .unwrap_or(0);
        assert_eq!(count, 0, "scratch files leaked into {}", tmp_dir.display());
    }

    #[test]
    fn opts_default_is_none_for_optional_fields() {
        let opts = TranscribeOpts::default();
        assert!(opts.model_path.is_none());
        assert!(opts.language.is_none());
    }

    #[test]
    fn wav_duration_handles_real_header() {
        // 16 kHz mono int16 with 32 000 bytes of data = 1 s.
        let mut wav = empty_wav_16khz_mono();
        let data_size = 32_000u32;
        wav[40..44].copy_from_slice(&data_size.to_le_bytes());
        // Pad the buffer so the validity check still passes — bytes
        // beyond the data subchunk are ignored by the parser.
        wav.resize(44 + data_size as usize, 0);
        assert_eq!(wav_duration_ms(&wav), 1000);
    }
}
