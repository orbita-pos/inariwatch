//! Session 1 — integration coverage for `cloud::auth::poll` device-flow
//! round-trip + the new `device_id` round-trip.
//!
//! `auth::poll` long-polls the server until "approved", parses the
//! response (including the new `deviceId` field), and persists both the
//! bearer + the device id. The persistence layer (SecretStore) tries
//! the OS keyring first and falls back to the SQL settings store. CI
//! environments don't have a keyring; we observe persistence through
//! `read_dashboard_creds` which is backend-agnostic.

use std::sync::{Arc, Mutex, MutexGuard};

use inariwatch_desktop_lib::cloud::api::read_dashboard_creds_arc;
use inariwatch_desktop_lib::cloud::auth;
use inariwatch_desktop_lib::cloud::keyring::SecretStore;
use inariwatch_desktop_lib::store::Store;

/// Same rationale as `devices_endpoints.rs`: integration tests run
/// against the real OS keyring, so concurrent tests would clobber
/// each other's `inariwatch.desktop` slot. Serialize via a static
/// mutex; clear the keyring on Drop so test runs leave no residue.
static KEYRING_LOCK: once_cell::sync::Lazy<Mutex<()>> =
    once_cell::sync::Lazy::new(|| Mutex::new(()));

struct TestRig {
    _tmp:    tempfile::TempDir,
    store:   Arc<Store>,
    secrets: SecretStore,
    _guard:  MutexGuard<'static, ()>,
}

impl Drop for TestRig {
    fn drop(&mut self) {
        self.secrets.clear();
    }
}

fn fresh_rig() -> TestRig {
    let guard = KEYRING_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let tmp = tempfile::tempdir().expect("tempdir");
    let db = tmp.path().join("inari-live").join("store.db");
    let store = Arc::new(Store::open_at(&db).expect("open store"));
    let secrets = SecretStore::new(store.clone());
    secrets.clear();
    TestRig { _tmp: tmp, store, secrets, _guard: guard }
}

#[tokio::test]
async fn poll_persists_token_and_returns_it_on_first_approved_tick() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;

    // `auth::poll` URL-encodes the code + appends label/os/hostname/
    // app_version query params. mockito's match_query with `Any` keeps
    // the test resilient to the host's hostname (CI hostnames differ).
    let _m = server
        .mock("GET", "/api/cli/auth/poll")
        .match_query(mockito::Matcher::Regex(r"code=test-code-1.*client=desktop".into()))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{
                "status":"approved",
                "apiToken":"inari_desktop_RAW_TOKEN_xyz",
                "deviceId":"11111111-2222-3333-4444-555555555555"
            }"#,
        )
        .create_async()
        .await;

    let token = auth::poll(&rig.store, "test-code-1".to_string(), server.url())
        .await
        .expect("poll approved");

    // Returned token matches the one the server minted.
    assert_eq!(token, "inari_desktop_RAW_TOKEN_xyz");

    // Persistence — read back via `read_dashboard_creds_arc`. Both the
    // bearer and the URL should be visible (URL stays in settings, bearer
    // goes to keyring → settings fallback).
    let creds = read_dashboard_creds_arc(&rig.store);
    assert_eq!(creds.token.as_deref(), Some("inari_desktop_RAW_TOKEN_xyz"));
    assert!(
        creds.base_url.starts_with(&server.url()),
        "expected dashboard_url persisted to {}, got {}",
        server.url(),
        creds.base_url,
    );
}

#[tokio::test]
async fn poll_propagates_expired_response() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;

    let _m = server
        .mock("GET", "/api/cli/auth/poll")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_body(r#"{"status":"expired"}"#)
        .create_async()
        .await;

    let err = auth::poll(&rig.store, "stale-code".to_string(), server.url())
        .await
        .expect_err("poll should error on expired");
    assert!(err.contains("expired") || err.contains("invalid"), "got: {}", err);
}

#[tokio::test]
async fn poll_treats_404_as_expired_or_invalid() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;

    let _m = server
        .mock("GET", "/api/cli/auth/poll")
        .match_query(mockito::Matcher::Any)
        .with_status(404)
        .with_body("")
        .create_async()
        .await;

    let err = auth::poll(&rig.store, "missing".to_string(), server.url())
        .await
        .expect_err("404 → error");
    assert!(err.contains("expired") || err.contains("invalid"), "got: {}", err);
}

#[tokio::test]
async fn auth_status_reflects_persisted_token_after_poll() {
    let rig = fresh_rig();
    let mut server = mockito::Server::new_async().await;

    let _m = server
        .mock("GET", "/api/cli/auth/poll")
        .match_query(mockito::Matcher::Any)
        .with_status(200)
        .with_body(
            r#"{
                "status":"approved",
                "apiToken":"inari_desktop_persistence_check",
                "deviceId":"abcdef01-2345-6789-abcd-ef0123456789"
            }"#,
        )
        .create_async()
        .await;

    auth::poll(&rig.store, "code-status-check".to_string(), server.url())
        .await
        .expect("poll");

    let status = auth::status(&rig.store);
    assert!(status.connected, "status must report connected after poll");
    assert!(
        status.api_url.starts_with(&server.url()),
        "status.api_url must echo the URL passed to poll",
    );
}
