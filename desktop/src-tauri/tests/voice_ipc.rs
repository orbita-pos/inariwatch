//! S9 — voice IPC round-trip integration tests.
//!
//! Exercises the public surface that the four `desktop_voice_*` Tauri
//! commands forward to:
//!
//!   - `voice::settings::{load, save}`     — KV round-trip through Store.
//!   - `voice::capabilities::detect`       — surface the disk + PATH probe.
//!   - `voice::WhisperBackend` (via Mock)  — shape of TranscriptionResult.
//!
//! The Tauri command shells themselves are thin (one line each) — a
//! genuine `tauri::test::mock_app` harness costs more than the tests
//! prevent, so we drive the underlying functions directly.

use std::sync::Arc;

use inariwatch_desktop_lib::store::Store;
use inariwatch_desktop_lib::voice::settings as voice_settings;
use inariwatch_desktop_lib::voice::settings::VoiceSettingsPatch;
use inariwatch_desktop_lib::voice::stt::{empty_wav_16khz_mono, TranscribeOpts};
use inariwatch_desktop_lib::voice::{detect_capabilities, VoiceSettings};

#[test]
fn voice_settings_default_when_no_keys_present() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).expect("open"));
    let loaded = voice_settings::load(&store).expect("load default");
    let defaults = VoiceSettings::default();
    assert_eq!(loaded, defaults);
}

#[test]
fn voice_settings_round_trip_through_save_and_load() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).expect("open"));

    let saved = voice_settings::save(
        &store,
        VoiceSettingsPatch {
            input_enabled: Some(true),
            output_enabled: Some(true),
            stt_model_path: Some("/Users/me/.inari/voice/models/foo.bin".to_string()),
            tts_voice: Some("es_MX-claude-medium".to_string()),
            auto_speak_responses: Some(true),
            push_to_talk: Some(false),
        },
    )
    .expect("save");

    assert!(saved.input_enabled);
    assert!(saved.output_enabled);
    assert_eq!(saved.tts_voice, "es_MX-claude-medium");
    assert!(!saved.push_to_talk);

    let loaded = voice_settings::load(&store).expect("load");
    assert_eq!(loaded, saved);
}

#[test]
fn voice_settings_partial_patch_keeps_other_fields() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).expect("open"));

    voice_settings::save(
        &store,
        VoiceSettingsPatch {
            input_enabled: Some(true),
            tts_voice: Some("en_US-amy-medium".to_string()),
            ..Default::default()
        },
    )
    .expect("seed");

    let after = voice_settings::save(
        &store,
        VoiceSettingsPatch {
            push_to_talk: Some(false),
            ..Default::default()
        },
    )
    .expect("patch");

    assert!(after.input_enabled, "prior input_enabled survives");
    assert_eq!(after.tts_voice, "en_US-amy-medium", "voice survives");
    assert!(!after.push_to_talk, "patch field flips");
}

#[test]
fn voice_settings_empty_voice_string_clears() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).expect("open"));

    voice_settings::save(
        &store,
        VoiceSettingsPatch {
            tts_voice: Some("en_US-amy-medium".to_string()),
            ..Default::default()
        },
    )
    .expect("seed voice");

    let cleared = voice_settings::save(
        &store,
        VoiceSettingsPatch {
            tts_voice: Some(String::new()),
            ..Default::default()
        },
    )
    .expect("clear voice");

    assert!(cleared.tts_voice.is_empty());
}

#[test]
fn voice_settings_persist_across_store_reopen() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("store.db");

    {
        let store = Arc::new(Store::open_at(&db_path).expect("open"));
        voice_settings::save(
            &store,
            VoiceSettingsPatch {
                input_enabled: Some(true),
                tts_voice: Some("en_GB-alan-medium".to_string()),
                ..Default::default()
            },
        )
        .expect("seed");
    }

    let store = Arc::new(Store::open_at(&db_path).expect("reopen"));
    let after = voice_settings::load(&store).expect("load");
    assert!(after.input_enabled);
    assert_eq!(after.tts_voice, "en_GB-alan-medium");
}

#[test]
fn capabilities_probe_reports_all_missing_on_clean_dirs() {
    let home = tempfile::tempdir().expect("home");
    let app = tempfile::tempdir().expect("app");
    let caps = detect_capabilities(Some(home.path()), app.path());
    // PATH may carry whisper-cli on a dev box; we don't pin
    // stt_available. Filesystem-only flags must all be false.
    assert!(!caps.whisper_model_present);
    assert!(!caps.tts_available);
    assert!(!caps.piper_model_present);
    assert!(!caps.whisper_model_path.is_empty());
}

#[test]
fn whisper_mock_backend_returns_canned_transcript() {
    use inariwatch_desktop_lib::voice::stt::TranscriptionResult;
    use inariwatch_desktop_lib::voice::WhisperBackend;

    // The `MockWhisperBackend` is `#[cfg(test)]`-only, so the
    // integration test reaches into the same binary that hosts it
    // by re-implementing the trait. The shape is what we want to
    // pin: text + engine + duration_ms.
    struct InlineMock;
    impl WhisperBackend for InlineMock {
        fn transcribe(
            &self,
            _wav: &[u8],
            _opts: &TranscribeOpts,
        ) -> Result<
            TranscriptionResult,
            inariwatch_desktop_lib::voice::TranscribeError,
        > {
            Ok(TranscriptionResult {
                text: "integration".to_string(),
                engine: "mock".to_string(),
                audio_duration_ms: 0,
            })
        }
    }

    let mock = InlineMock;
    let res = mock
        .transcribe(&empty_wav_16khz_mono(), &TranscribeOpts::default())
        .expect("ok");
    assert_eq!(res.text, "integration");
    assert_eq!(res.engine, "mock");
}
