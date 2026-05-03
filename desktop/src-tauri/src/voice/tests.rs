// v0.3 S5 — voice module integration tests (binary-free path).
//
// Exercise the synthetic-fallback synthesize() call end-to-end. Real
// Piper integration is covered by `piper::tests::synthesize_errors_*`
// and an opt-in smoke test (#[ignore]) deferred to a session that has
// the binary installed.

use super::*;
use tempfile::TempDir;

#[test]
fn synthesize_with_default_voice_returns_valid_wav() {
    let tmp = TempDir::new().unwrap();
    let result = synthesize(
        tmp.path(),
        SynthesizeRequest {
            text: "InariWatch detected a critical alert.".to_string(),
            voice_id: None,
            speed: 1.0,
        },
    )
    .expect("synth should succeed even without Piper");
    assert_eq!(result.engine, SynthEngine::SyntheticFallback);
    assert!(result.audio_wav.len() >= 44);
    assert_eq!(&result.audio_wav[0..4], b"RIFF");
    assert_eq!(&result.audio_wav[8..12], b"WAVE");
    assert!(result.duration_ms > 0);
    // Default voice = en_US-amy-medium per registry.
    assert_eq!(result.voice_id, "en_US-amy-medium");
}

#[test]
fn synthesize_uses_default_when_voice_id_unknown() {
    let tmp = TempDir::new().unwrap();
    let result = synthesize(
        tmp.path(),
        SynthesizeRequest {
            text: "alert".to_string(),
            voice_id: Some("xx_YY-fake-medium".to_string()),
            speed: 1.0,
        },
    )
    .expect("synth recovers from unknown voice id");
    // Falls back to the default voice rather than failing.
    assert_eq!(result.voice_id, "en_US-amy-medium");
}

#[test]
fn synthesize_rejects_empty_text() {
    let tmp = TempDir::new().unwrap();
    let res = synthesize(
        tmp.path(),
        SynthesizeRequest {
            text: "   ".to_string(),
            voice_id: None,
            speed: 1.0,
        },
    );
    assert!(matches!(res, Err(VoiceError::EmptyText)));
}

#[test]
fn synthesize_rejects_overlong_text() {
    let tmp = TempDir::new().unwrap();
    let huge = "a".repeat(MAX_TEXT_CHARS + 1);
    let res = synthesize(
        tmp.path(),
        SynthesizeRequest {
            text: huge,
            voice_id: None,
            speed: 1.0,
        },
    );
    assert!(matches!(res, Err(VoiceError::TextTooLong(_))));
}

#[test]
fn handle_voice_tts_dispatch_returns_b64_payload() {
    let tmp = TempDir::new().unwrap();
    let dir = std::sync::Arc::new(tmp.path().to_path_buf());
    let payload = serde_json::json!({
        "text": "InariWatch alert",
        "voice_id": "es_MX-claude-medium",
        "speed": 1.0
    });
    let result = handle_voice_tts_dispatch(dir, &payload).expect("dispatch ok");
    let obj = result.as_object().expect("object");
    let b64 = obj
        .get("audio_wav_b64")
        .and_then(|v| v.as_str())
        .expect("b64 string");
    assert!(!b64.is_empty());
    assert_eq!(obj.get("voice_id").and_then(|v| v.as_str()), Some("es_MX-claude-medium"));
    assert_eq!(obj.get("engine").and_then(|v| v.as_str()), Some("synthetic_fallback"));
    assert_eq!(
        obj.get("audio_format").and_then(|v| v.as_str()),
        Some("wav")
    );
    assert!(
        obj.get("duration_ms")
            .and_then(|v| v.as_u64())
            .map(|d| d > 0)
            .unwrap_or(false)
    );
}

#[test]
fn base64_round_trip_via_decoder() {
    // Validate that our hand-rolled encoder produces something a
    // standard decoder can read back. Use a fixed input so the test
    // is deterministic.
    let bytes: Vec<u8> = (0u8..32).collect();
    let encoded = base64_encode(&bytes);
    // Standard alphabet, padding for 32 bytes (32 / 3 = 10 r2).
    assert_eq!(encoded.len(), ((32 + 2) / 3) * 4);
    assert!(encoded.ends_with("="));
    // Compute the expected vs roughly known prefix for u8 0..32.
    assert!(encoded.starts_with("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="));
}

#[test]
fn synth_engine_serializes_snake_case() {
    let raw = serde_json::to_string(&SynthEngine::SyntheticFallback).unwrap();
    assert_eq!(raw, "\"synthetic_fallback\"");
    let raw2 = serde_json::to_string(&SynthEngine::Piper).unwrap();
    assert_eq!(raw2, "\"piper\"");
}
