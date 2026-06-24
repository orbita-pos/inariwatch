// v0.3 S5 — unit tests for the Baileys sidecar manager.
//
// We can't spawn the actual Node sidecar from `cargo test` (no node
// runtime, no built `dist/main.js` in CI), so these tests cover the
// pure-Rust paths:
//
//   1. Type round-trips (JSON-RPC frames, events).
//   2. The accounts-cache update logic (`update_accounts_for_event`)
//      via direct calls into the manager's snapshot.
//   3. RPC timeout when no sidecar is running.
//
// Integration tests that spawn a stub Node script ship as
// `desktop/src-tauri/tests/whatsapp_sidecar_smoke.rs` — opt-in via the
// `whatsapp-smoke` feature flag so the default `cargo test` run stays
// hermetic.

use std::path::PathBuf;
use std::time::Duration;

use super::sidecar::{SidecarConfig, SidecarManager};
use super::types::{
    AccountInfo, ConnectionStatus, SendMessageRequest, WhatsAppEvent,
};

fn cfg(timeout_ms: u64) -> SidecarConfig {
    let tmp = std::env::temp_dir().join("inari-test-whatsapp-auth");
    SidecarConfig {
        script_path: PathBuf::from("does/not/exist/main.js"),
        auth_root: tmp,
        node_binary: Some(PathBuf::from("does-not-exist-node")),
        rpc_timeout_ms: timeout_ms,
    }
}

#[tokio::test]
async fn list_accounts_starts_empty() {
    let mgr = SidecarManager::new(cfg(100));
    assert!(mgr.list_accounts().await.is_empty());
}

#[tokio::test]
async fn account_status_returns_none_for_unknown() {
    let mgr = SidecarManager::new(cfg(100));
    assert!(mgr.account_status("does-not-exist").await.is_none());
}

#[tokio::test]
async fn login_start_seeds_qr_pending_account() {
    let mgr = SidecarManager::new(cfg(50));
    // Sidecar isn't running — login_start will time out trying to write
    // to stdin. That's fine; we only assert the cache pre-seed happened.
    let _ = mgr.login_start("personal", "Personal").await;
    let info = mgr
        .account_status("personal")
        .await
        .expect("seeded entry should exist even when RPC fails");
    assert_eq!(info.account_id, "personal");
    assert_eq!(info.label, "Personal");
    assert_eq!(info.status, ConnectionStatus::QrPending);
    assert!(info.self_jid.is_none());
}

#[tokio::test]
async fn rpc_call_times_out_when_sidecar_missing() {
    let mgr = SidecarManager::new(cfg(50));
    let res = mgr
        .send_message(SendMessageRequest {
            account_id: "personal".into(),
            to: "5215551234567".into(),
            body: "hi".into(),
            reply_to: None,
        })
        .await;
    assert!(res.is_err(), "expected error when sidecar isn't running");
    let err = res.unwrap_err().to_string();
    // Either "sidecar not running" (no stdin handle) OR a timeout —
    // both are valid responses to "manager started without spawning".
    assert!(
        err.contains("not running") || err.contains("timed out"),
        "unexpected error string: {err}"
    );
}

#[tokio::test]
async fn shutdown_is_idempotent_without_supervisor() {
    let mgr = SidecarManager::new(cfg(50));
    // shutdown() before start() should be a no-op (supervisor was never
    // spawned). It used to deadlock — regression guard.
    let _ = tokio::time::timeout(Duration::from_secs(1), mgr.shutdown())
        .await
        .expect("shutdown without supervisor should return quickly");
}

#[test]
fn whatsapp_event_qr_update_serializes_with_type_tag() {
    let evt = WhatsAppEvent::QrUpdate {
        account_id: "personal".into(),
        qr: "MOCK-QR-STR".into(),
        ts_ms: 1_700_000_000_000,
    };
    let raw = serde_json::to_value(&evt).unwrap();
    assert_eq!(raw["type"], "qr_update");
    assert_eq!(raw["qr"], "MOCK-QR-STR");
}

#[test]
fn account_info_round_trips_through_json() {
    let info = AccountInfo {
        account_id: "personal".into(),
        label: "Personal".into(),
        self_jid: Some("5215551234567@s.whatsapp.net".into()),
        status: ConnectionStatus::Connected,
        last_qr_at_ms: Some(1_700_000_000_000),
        last_linked_at_ms: Some(1_700_000_000_500),
    };
    let raw = serde_json::to_string(&info).unwrap();
    let back: AccountInfo = serde_json::from_str(&raw).unwrap();
    assert_eq!(info, back);
}
