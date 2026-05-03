//! Integration tests for the v0.3 S2 relay client.
//!
//! Real WS connectivity is exercised by the Go relay's own integration
//! tests (services/relay/*_test.go). This file validates the parts of
//! the Rust client that don't require a live network: backoff progression,
//! capability surface, dispatch-frame serialization, and the stub
//! response contract that web's user-sidecar provider falls back from.

use inariwatch_desktop_lib::relay_client::{
    build_stub_response, handle_dispatch, handle_dispatch_full, RelayConfig,
    RelayState, CAPABILITIES,
};
use serde_json::json;

#[test]
fn capabilities_advertise_v0_3_surface() {
    // §3 of INARI_AI_ARCHITECTURE.md — sidecar covers notify.*, voice.tts,
    // chat.conversational, redact.*. Tests guard against a future
    // accidental list pruning.
    for must_advertise in [
        "notify.compose.email",
        "notify.compose.slack",
        "notify.compose.telegram",
        "notify.compose.whatsapp",
        "notify.compose.push",
        "notify.compose.digest",
        "notify.compose.status-page",
        "notify.compose.postmortem-prose",
        "voice.tts.alert",
        "voice.tts.digest",
        "chat.conversational",
        "redact.pii.breadcrumbs",
        "redact.pii.stacktrace",
    ] {
        assert!(
            CAPABILITIES.contains(&must_advertise),
            "missing capability {must_advertise}",
        );
    }
}

#[test]
fn ws_url_constructs_correctly() {
    let cfg = RelayConfig {
        base_url: "wss://relay.inariwatch.com".into(),
        jwt: "tok".into(),
        app_version: "0.3.0".into(),
        initial_backoff: None,
        local_ai: None,
        app_local_data_dir: None,
        whatsapp: None,
    };
    assert_eq!(cfg.ws_url(), "wss://relay.inariwatch.com/ws");
}

#[test]
fn relay_state_serde_round_trip() {
    for s in [
        RelayState::Disconnected,
        RelayState::Connecting,
        RelayState::Connected,
        RelayState::Reconnecting,
    ] {
        let raw = serde_json::to_string(&s).unwrap();
        let back: RelayState = serde_json::from_str(&raw).unwrap();
        assert_eq!(s, back);
    }
    // Frontend bridge expects snake_case.
    let r = serde_json::to_string(&RelayState::Reconnecting).unwrap();
    assert_eq!(r, "\"reconnecting\"");
}

#[test]
fn stub_response_satisfies_relay_contract() {
    // Mimic a dispatch frame the Go relay would forward. `build_stub_response`
    // is the bare-bones stub builder — the dispatcher routes
    // `notify.compose.email` to a real handler when local_ai is wired, but
    // the builder itself still returns a stub no matter the task. This test
    // covers the contract for tasks the dispatcher CAN'T satisfy locally.
    let raw_dispatch = json!({
        "type": "dispatch",
        "request_id": "abc-123",
        "task": "voice.tts.alert",
        "payload": {"text": "x"},
    });
    let df: inariwatch_desktop_lib::relay_client::DispatchFrame =
        serde_json::from_value(raw_dispatch).unwrap();
    let resp = build_stub_response(&df);
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v["request_id"], "abc-123");
    assert_eq!(v["type"], "response");
    assert_eq!(v["status"], "ok");
    assert_eq!(v["body"]["task"], "voice.tts.alert");
    assert_eq!(v["body"]["stub"], true);
}

// v0.3 S3 — `handle_dispatch` is the real entry point. We cover the
// fallback branch (no LocalAI handle) here because it doesn't need a
// model spawned. Real-model coverage lives in the eval harness +
// end-to-end smoke per `INARI_LIVE_V0_3_HANDOFF.md` v0.3 S3 § Smoke.
#[tokio::test]
async fn handle_dispatch_email_falls_back_when_no_local_ai() {
    let df: inariwatch_desktop_lib::relay_client::DispatchFrame = serde_json::from_value(json!({
        "type": "dispatch",
        "request_id": "rid-fallback",
        "task": "notify.compose.email",
        "payload": {"alert": {"title": "Boom"}},
    }))
    .unwrap();
    let resp = handle_dispatch(None, &df).await;
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v["request_id"], "rid-fallback");
    assert_eq!(v["status"], "ok");
    let note = v["body"]["note"].as_str().unwrap_or("");
    assert!(
        note.contains("local_ai not initialized"),
        "expected fallback note, got {note:?}",
    );
}

// v0.3 S5 (Baileys rewrite) — whatsapp + voice plumbing.
//
// We can't spawn the Baileys sidecar (no npm install in CI), so we
// exercise the dispatch-routing branches that DON'T require it:
// LocalAI=None plus whatsapp=None routes whatsapp to the same
// "local_ai not initialized" stub as email (matches the rule's
// no-cloud-fallback contract — caller decides graceful degradation).
#[tokio::test]
async fn handle_dispatch_full_whatsapp_falls_back_when_no_local_ai() {
    let df: inariwatch_desktop_lib::relay_client::DispatchFrame = serde_json::from_value(json!({
        "type": "dispatch",
        "request_id": "rid-wa",
        "task": "notify.compose.whatsapp",
        "payload": {"alert": {"title": "Boom"}, "recipient_phone": "5215551234567"},
    }))
    .unwrap();
    let resp = handle_dispatch_full(None, None, None, &df).await;
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v["status"], "ok");
    let note = v["body"]["note"].as_str().unwrap_or("");
    assert!(
        note.contains("local_ai not initialized"),
        "expected local_ai fallback, got {note:?}",
    );
}

#[tokio::test]
async fn handle_dispatch_full_voice_works_without_local_ai() {
    // Voice doesn't need LocalAI — Piper subprocess + synthetic fallback.
    let df: inariwatch_desktop_lib::relay_client::DispatchFrame = serde_json::from_value(json!({
        "type": "dispatch",
        "request_id": "rid-voice",
        "task": "voice.tts.alert",
        "payload": {"text": "hello"},
    }))
    .unwrap();
    let resp = handle_dispatch_full(None, None, None, &df).await;
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v["status"], "ok");
    // Either real Piper succeeded (unlikely in CI) or the synthetic
    // fallback fired — both produce an audio_wav_b64 + audio_format=wav.
    let body = &v["body"];
    assert_eq!(body["audio_format"], "wav");
    assert!(body["audio_wav_b64"].is_string());
}
