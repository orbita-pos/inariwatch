//! Sesión 27 — replay button surfaces "no recording" CTA when the
//! receipt has no `recording_id`. Per the Sesión-27 spec, the dock's
//! `ReplayButton` renders a CTA in that case instead of attempting
//! the call. This test exercises the same branch via the IPC inner
//! function — no Tauri runtime, no mock backend (the call must not
//! reach `/v2/replay` at all).

use std::sync::Arc;

use inariwatch_desktop_lib::ipc::replay::{
    replay_against_patch_with_store, ReplayAgainstPatchArgs, ReplayResultDto,
};
use inariwatch_desktop_lib::store::queries::{
    self, NewEapReceipt, NewRemediationSession, RemediationMode,
};
use inariwatch_desktop_lib::store::settings;
use inariwatch_desktop_lib::store::Store;

fn open_store() -> Arc<Store> {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("no_rec.db")).expect("open store"),
    );
    std::mem::forget(dir);
    store
}

#[tokio::test]
async fn no_receipt_surfaces_no_receipt_variant() {
    let store = open_store();
    queries::upsert_repo(&store, "repo-x", "/tmp/x", "x", 0).unwrap();
    queries::insert_remediation_session(
        &store,
        &NewRemediationSession {
            id:                "sess-x",
            repo_id:           "repo-x",
            mode:              RemediationMode::Local,
            error_fingerprint: None,
            error_message:     None,
            created_at_ms:     0,
        },
    )
    .unwrap();

    // Receipts table is empty for this session.
    let res = replay_against_patch_with_store(
        &store,
        ReplayAgainstPatchArgs {
            session_id: "sess-x".to_string(),
            alert_id:   "alert-x".to_string(),
        },
    )
    .await
    .expect("ipc returns ok");
    assert!(
        matches!(res, ReplayResultDto::NoReceipt),
        "expected NoReceipt, got {res:?}",
    );
}

#[tokio::test]
async fn receipt_without_recording_id_surfaces_no_recording_variant() {
    let store = open_store();
    queries::upsert_repo(&store, "repo-y", "/tmp/y", "y", 0).unwrap();
    queries::insert_remediation_session(
        &store,
        &NewRemediationSession {
            id:                "sess-y",
            repo_id:           "repo-y",
            mode:              RemediationMode::Local,
            error_fingerprint: None,
            error_message:     None,
            created_at_ms:     0,
        },
    )
    .unwrap();

    // Receipt exists but recording_id is None — the spec says the
    // button must show "no recording — generate one" CTA.
    let merkle = "merkle-no-rec";
    queries::insert_eap_receipt(
        &store,
        &NewEapReceipt {
            receipt_id:             merkle,
            remediation_session_id: "sess-y",
            merkle_root:            merkle,
            signature:              None,
            signed:                 false,
            prompt_hash:            None,
            system_prompt:          None,
            tools_called_json:      "[]",
            files_read_json:        "[]",
            model:                  None,
            recording_id:           None,
            attestor:               "inariwatch",
            created_at_ms:          1,
        },
    )
    .unwrap();

    // Set replay_token so we can prove we'd otherwise have called the
    // endpoint — this short-circuit is upstream of the network call.
    settings::set(&store, "replay_token", "irrelevant").unwrap();

    let res = replay_against_patch_with_store(
        &store,
        ReplayAgainstPatchArgs {
            session_id: "sess-y".to_string(),
            alert_id:   "alert-y".to_string(),
        },
    )
    .await
    .expect("ipc returns ok");

    match res {
        ReplayResultDto::NoRecording { receipt_id } => {
            assert_eq!(receipt_id, merkle);
        }
        other => panic!("expected NoRecording, got {other:?}"),
    }
}
