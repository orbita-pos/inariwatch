//! Sesión 19 — `orchestrator::reject_diff` updates the row state +
//! publishes a `FixRejected` event on the bus.
//!
//! Inserts a mock `remediation_sessions` row in the `draft` state,
//! subscribes to the bus, calls `reject_diff`, and asserts:
//!   - the row state flips to `rejected`
//!   - a `FixRejected { session_id, reason }` event lands on the bus

use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::ai::remediate::orchestrator::reject_diff;
use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent};
use inariwatch_desktop_lib::store::queries::{
    get_remediation_session, insert_remediation_session, update_remediation_session,
    upsert_repo, NewRemediationSession, RemediationMode, RemediationState,
    RemediationUpdate,
};
use inariwatch_desktop_lib::store::Store;

const REPO_ID:    &str = "repo-rej";
const SESSION_ID: &str = "sess-rej-1";

fn open_store() -> Arc<Store> {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("reject.db")).expect("open store"),
    );
    std::mem::forget(dir);
    store
}

fn seed_draft_session(store: &Store) {
    upsert_repo(store, REPO_ID, "/tmp/reject-repo", "rej", 0).unwrap();
    insert_remediation_session(
        store,
        &NewRemediationSession {
            id:                SESSION_ID,
            repo_id:           REPO_ID,
            mode:              RemediationMode::Local,
            error_fingerprint: Some("fp-rej"),
            error_message:     Some("boom"),
            created_at_ms:     0,
        },
    )
    .unwrap();
    update_remediation_session(
        store,
        SESSION_ID,
        &RemediationUpdate {
            state:      Some(RemediationState::Draft),
            draft_diff: Some("--- a/x\n+++ b/x\n"),
            ..Default::default()
        },
    )
    .unwrap();
}

#[tokio::test]
async fn reject_diff_marks_row_and_emits_event() {
    let store  = open_store();
    seed_draft_session(&store);
    let daemon = Arc::new(start_daemon());

    // Subscribe BEFORE rejecting so we don't miss the event.
    let rx = daemon.bus.subscribe();

    reject_diff(&store, &daemon, SESSION_ID, Some("wrong fix".to_string())).expect("reject");

    // Drain bus events. Look for the FixRejected variant within the
    // bounded window — the bus is in-memory so this should be effectively
    // instant.
    let deadline = std::time::Instant::now() + Duration::from_millis(500);
    let mut found: Option<(String, Option<String>)> = None;
    while std::time::Instant::now() < deadline && found.is_none() {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(DaemonEvent::FixRejected { session_id, reason }) => {
                found = Some((session_id, reason));
            }
            Ok(_)  => continue,
            Err(_) => continue,
        }
    }
    let (sid, reason) = found.expect("FixRejected should be on the bus");
    assert_eq!(sid, SESSION_ID);
    assert_eq!(reason.as_deref(), Some("wrong fix"));

    // Row state flipped.
    let row = get_remediation_session(&store, SESSION_ID).expect("get").expect("present");
    assert_eq!(row.state, "rejected");
    assert!(row.completed_at_ms.is_some(), "completed_at should be stamped");

    daemon.shutdown();
}

#[tokio::test]
async fn reject_diff_is_idempotent_on_already_rejected() {
    let store  = open_store();
    seed_draft_session(&store);
    let daemon = Arc::new(start_daemon());

    reject_diff(&store, &daemon, SESSION_ID, None).expect("reject 1");
    // Second call should be a quiet no-op (no error, no state churn).
    let rx2 = daemon.bus.subscribe();
    reject_diff(&store, &daemon, SESSION_ID, Some("double".to_string())).expect("reject 2");
    // Allow a short window for any (unwanted) event to arrive.
    let recvd = rx2.recv_timeout(Duration::from_millis(100));
    assert!(
        recvd.is_err(),
        "second reject should not emit a FixRejected event; got {recvd:?}",
    );

    daemon.shutdown();
}
