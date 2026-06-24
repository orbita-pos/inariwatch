//! Sesión 27 — replay button posts to /v2/replay and surfaces the verdict.
//!
//! Boots a local axum server emulating the Hetzner `/v2/replay`
//! endpoint, points the daemon's settings KV at it, seeds an EAP
//! receipt with a `recording_id`, then calls
//! `ipc::replay::replay_against_patch_with_store` and asserts the
//! tagged-union DTO arrives in the `Ok` shape with `throw_reproduced =
//! false` (the patch prevented the throw — green ✓ in the dock).
//!
//! The mock asserts the request body carries `recording_url`,
//! `auth_header` (Bearer of dashboard_token), `fix_branch` (commit_sha
//! from the session) — the same wire shape `inari_watcher::ReplayRequest`
//! ships in production.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{routing::post, Json, Router};
use inariwatch_desktop_lib::ipc::replay::{
    replay_against_patch_with_store, ReplayAgainstPatchArgs, ReplayResultDto,
};
use inariwatch_desktop_lib::store::queries::{
    self, NewEapReceipt, NewRemediationSession, RemediationMode,
};
use inariwatch_desktop_lib::store::settings;
use inariwatch_desktop_lib::store::Store;
use serde_json::{json, Value};
use tokio::sync::Mutex;

#[derive(Default)]
struct Captured {
    body: Option<Value>,
}

async fn handler(
    state: axum::extract::State<Arc<Mutex<Captured>>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    {
        let mut g = state.lock().await;
        g.body = Some(body.clone());
    }
    Json(json!({
        "throw_reproduced": false,
        "throws":           [],
        "runner_mode":      "drain-only",
        "fix_branch":       body.get("fix_branch").cloned(),
        "duration_ms":      123,
    }))
}

async fn boot_mock_replay() -> (SocketAddr, Arc<Mutex<Captured>>) {
    let captured = Arc::new(Mutex::new(Captured::default()));
    let app = Router::new()
        .route("/v2/replay", post(handler))
        .with_state(captured.clone());
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app).await.unwrap();
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    (addr, captured)
}

fn open_store() -> Arc<Store> {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("replay.db")).expect("open store"),
    );
    std::mem::forget(dir);
    store
}

fn seed_session_and_receipt(store: &Store) {
    queries::upsert_repo(store, "repo-1", "/tmp/repo", "demo", 0)
        .expect("upsert_repo");
    queries::insert_remediation_session(
        store,
        &NewRemediationSession {
            id:                "sess-r",
            repo_id:           "repo-1",
            mode:              RemediationMode::Local,
            error_fingerprint: Some("fp-r"),
            error_message:     Some("err"),
            created_at_ms:     0,
        },
    )
    .expect("insert session");
    queries::update_remediation_session(
        store,
        "sess-r",
        &queries::RemediationUpdate {
            commit_sha: Some("deadbee"),
            ..Default::default()
        },
    )
    .expect("update session");
    queries::insert_eap_receipt(
        store,
        &NewEapReceipt {
            receipt_id:             "merkle-r",
            remediation_session_id: "sess-r",
            merkle_root:            "merkle-r",
            signature:              None,
            signed:                 false,
            prompt_hash:            None,
            system_prompt:          None,
            tools_called_json:      "[]",
            files_read_json:        "[]",
            model:                  None,
            recording_id:           Some("rec_42"),
            attestor:               "inariwatch",
            created_at_ms:          1,
        },
    )
    .expect("insert receipt");
}

#[tokio::test]
async fn replay_button_calls_endpoint_and_renders_green() {
    let (addr, captured) = boot_mock_replay().await;
    let store = open_store();
    seed_session_and_receipt(&store);

    // Point the daemon at our mock — replay_url + replay_token.
    settings::set(&store, "replay_url",     &format!("http://{addr}/v2/replay"))
        .expect("set replay_url");
    settings::set(&store, "replay_token",   "test-staging-secret")
        .expect("set replay_token");
    settings::set(&store, "dashboard_url",  "http://dashboard.test")
        .expect("set dashboard_url");
    settings::set(&store, "dashboard_token", "dash-bearer")
        .expect("set dashboard_token");

    let res = replay_against_patch_with_store(
        &store,
        ReplayAgainstPatchArgs {
            session_id: "sess-r".to_string(),
            alert_id:   "alert-1".to_string(),
        },
    )
    .await
    .expect("replay returns ok");

    match res {
        ReplayResultDto::Ok {
            throw_reproduced,
            throws_after,
            runner_mode,
            fix_branch,
            duration_ms,
            ..
        } => {
            assert!(!throw_reproduced, "throw must NOT reproduce on the patch");
            assert_eq!(throws_after, 0);
            assert_eq!(runner_mode.as_deref(), Some("drain-only"));
            assert_eq!(fix_branch.as_deref(), Some("deadbee"));
            assert_eq!(duration_ms, Some(123));
        }
        other => panic!("expected Ok variant, got {other:?}"),
    }

    // Assert the wire shape — body must match the production request.
    let body = captured
        .lock()
        .await
        .body
        .clone()
        .expect("mock captured body");
    assert_eq!(
        body["recording_url"],
        json!("http://dashboard.test/api/recordings/rec_42/binary"),
    );
    assert_eq!(body["auth_header"], json!("Bearer dash-bearer"));
    assert_eq!(body["fix_branch"],  json!("deadbee"));
    assert_eq!(body["timeout_seconds"], json!(60));
}

#[tokio::test]
async fn replay_button_surfaces_config_missing_when_token_absent() {
    let store = open_store();
    seed_session_and_receipt(&store);
    // Intentionally NOT setting replay_token — IPC should short-circuit.
    let res = replay_against_patch_with_store(
        &store,
        ReplayAgainstPatchArgs {
            session_id: "sess-r".to_string(),
            alert_id:   "alert-1".to_string(),
        },
    )
    .await
    .expect("replay returns ok");
    match res {
        ReplayResultDto::ConfigMissing { reason } => {
            assert!(reason.contains("replay_token"));
        }
        other => panic!("expected ConfigMissing, got {other:?}"),
    }
}
