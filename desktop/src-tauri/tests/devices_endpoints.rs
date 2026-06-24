//! Session 1 — integration tests for `cloud::devices` HTTP wrappers.
//!
//! Same pattern as `cloud_widgets.rs`: mockito stands up a fake server,
//! we wire creds via the cloud::keyring::SecretStore (writes to OS
//! keyring with SQL-settings fallback), and exercise each helper.
//! AppHandle is `None` so the 401-invalidate path skips the event emit
//! (no Tauri runtime in unit-style integration tests).
//!
//! ## Why we serialize via a global mutex
//!
//! Integration tests run with `cfg(test)` set inside the test binary
//! but NOT inside `inariwatch_desktop_lib`. That means SecretStore hits
//! the REAL OS keyring — Windows Credential Manager / macOS Keychain /
//! Linux Secret Service — and concurrent tests would clobber each
//! other's `inariwatch.desktop` entry. The static `KEYRING_LOCK`
//! ensures only one test touches the keyring at a time.

use std::sync::{Mutex, MutexGuard};

use inariwatch_desktop_lib::cloud::devices;
use inariwatch_desktop_lib::cloud::keyring::SecretStore;
use inariwatch_desktop_lib::store::{settings, Store};

static KEYRING_LOCK: once_cell::sync::Lazy<Mutex<()>> =
    once_cell::sync::Lazy::new(|| Mutex::new(()));

struct TestRig {
    _tmp:    tempfile::TempDir,
    store:   std::sync::Arc<Store>,
    secrets: SecretStore,
    _guard:  MutexGuard<'static, ()>,
}

impl Drop for TestRig {
    fn drop(&mut self) {
        // Don't leave test creds behind for the next run / dev session.
        self.secrets.clear();
    }
}

fn fresh_rig() -> TestRig {
    let guard = KEYRING_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let tmp = tempfile::tempdir().expect("tempdir");
    let db = tmp.path().join("inari-live").join("store.db");
    let store = std::sync::Arc::new(Store::open_at(&db).expect("open store"));
    let secrets = SecretStore::new(store.clone());
    // Start each test with an empty keyring so the host machine's
    // pre-existing entries don't bleed in.
    secrets.clear();
    TestRig { _tmp: tmp, store, secrets, _guard: guard }
}

fn wire_creds(rig: &TestRig, base_url: &str) {
    settings::set(&rig.store, "dashboard_url", base_url).expect("dashboard_url");
    rig.secrets.set("test-token", None).expect("seed test-token");
}

#[tokio::test]
async fn list_decodes_payload_with_current_device_flag() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&rig, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/devices")
        .match_header("authorization", "Bearer test-token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{
                "devices":[
                    {"deviceId":"d1","label":"laptop-jesus","os":"macos","hostname":"laptop-jesus.local","appVersion":"0.1.0","createdAt":"2026-05-08T00:00:00Z","lastSeenAt":"2026-05-08T01:00:00Z","isCurrent":true},
                    {"deviceId":"d2","label":"macmini-studio","os":"macos","hostname":null,"appVersion":null,"createdAt":"2026-05-07T00:00:00Z","lastSeenAt":"2026-05-07T18:00:00Z","isCurrent":false}
                ],
                "currentDeviceId":"d1"
            }"#,
        )
        .create_async()
        .await;

    let result = devices::list(None, &rig.store).await.expect("list");
    assert_eq!(result.devices.len(), 2);
    assert_eq!(result.current_device_id.as_deref(), Some("d1"));

    let d1 = &result.devices[0];
    assert_eq!(d1.device_id, "d1");
    assert_eq!(d1.label, "laptop-jesus");
    assert!(d1.is_current);
    assert_eq!(d1.os.as_deref(), Some("macos"));
    assert_eq!(d1.hostname.as_deref(), Some("laptop-jesus.local"));

    let d2 = &result.devices[1];
    assert!(!d2.is_current);
    assert!(d2.hostname.is_none());
    assert!(d2.app_version.is_none());
}

#[tokio::test]
async fn list_surfaces_unauthorized_string_on_401() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&rig, &server.url());

    let _m = server
        .mock("GET", "/api/desktop/devices")
        .with_status(401)
        .with_body(r#"{"error":"Unauthorized"}"#)
        .create_async()
        .await;

    let err = devices::list(None, &rig.store).await.expect_err("must be Err");
    assert_eq!(err, "unauthorized");
}

#[tokio::test]
async fn list_returns_not_connected_when_token_absent() {
    let rig = fresh_rig();
    // `dashboard_url` set but no token (rig.secrets.clear() in fresh_rig
    // ensured the keyring slot is empty) — is_connected() is false.
    settings::set(&rig.store, "dashboard_url", "http://does.not.matter").expect("url");

    let err = devices::list(None, &rig.store).await.expect_err("must be Err");
    assert_eq!(err, "not_connected");
}

#[tokio::test]
async fn rename_sends_label_in_json_body() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&rig, &server.url());

    let _m = server
        .mock("PATCH", "/api/desktop/devices/abc-123")
        .match_header("authorization", "Bearer test-token")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "label": "Jesus's MacBook Pro"
        })))
        .with_status(200)
        .with_body(r#"{"deviceId":"abc-123","label":"Jesus's MacBook Pro"}"#)
        .create_async()
        .await;

    devices::rename(None, &rig.store, "abc-123", "Jesus's MacBook Pro")
        .await
        .expect("rename");
}

#[tokio::test]
async fn revoke_sends_delete_with_bearer() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&rig, &server.url());

    let _m = server
        .mock("DELETE", "/api/desktop/devices/abc-123")
        .match_header("authorization", "Bearer test-token")
        .with_status(200)
        .with_body(r#"{"ok":true,"revoked":true}"#)
        .create_async()
        .await;

    devices::revoke(None, &rig.store, "abc-123").await.expect("revoke");
}

#[tokio::test]
async fn sign_out_all_decodes_revoked_count() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;
    wire_creds(&rig, &server.url());

    let _m = server
        .mock("POST", "/api/desktop/devices/sign-out-all")
        .match_header("authorization", "Bearer test-token")
        .with_status(200)
        .with_body(r#"{"ok":true,"revokedCount":3}"#)
        .create_async()
        .await;

    let result = devices::sign_out_all(None, &rig.store).await.expect("sign-out-all");
    assert!(result.ok);
    assert_eq!(result.revoked_count, 3);
}
