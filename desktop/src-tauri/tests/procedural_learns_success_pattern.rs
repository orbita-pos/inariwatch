//! Sesión 12 — procedural learner happy path.
//!
//! Spawns the learner against a real bus + store + tempdir-backed
//! repo, publishes 3× `RemediationCompleted { success: true }` for
//! the same fingerprint, and asserts:
//!   * `.inari/patterns.json` exists with one entry
//!   * `success_count == 3`, `kind == "auto-detected"`, evidence has
//!     all three session ids
//!   * 3× `DaemonEvent::PatternLearned` were published

use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent};
use inariwatch_desktop_lib::memory::procedural::{
    learner::{load_patterns, patterns_path},
    spawn_pattern_learner, PatternKind,
};
use inariwatch_desktop_lib::store::queries::{
    insert_remediation_session, upsert_repo, NewRemediationSession, RemediationMode,
};
use inariwatch_desktop_lib::store::Store;

const REPO_ID:     &str = "repo-procedural-success";
const FINGERPRINT: &str = "fp_typeerror_x_is_null";

fn open_store_and_repo() -> (Arc<Store>, tempfile::TempDir) {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("inari.db")).expect("open store"),
    );
    let repo_path = dir.path().to_string_lossy().into_owned();
    upsert_repo(&store, REPO_ID, &repo_path, "procedural-test", 0).unwrap();
    (store, dir)
}

fn seed_session(store: &Store, id: &str) {
    insert_remediation_session(
        store,
        &NewRemediationSession {
            id,
            repo_id:           REPO_ID,
            mode:              RemediationMode::Local,
            error_fingerprint: Some(FINGERPRINT),
            error_message:     Some("TypeError: x is null"),
            created_at_ms:     0,
        },
    )
    .expect("seed remediation_sessions row");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_successes_create_one_pattern_with_count_three() {
    let (store, repo_dir) = open_store_and_repo();
    let daemon = Arc::new(start_daemon());

    // Capture PatternLearned events on a separate subscriber.
    let observer = daemon.bus.subscribe();

    let _learner = spawn_pattern_learner(daemon.clone(), store.clone());
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Seed three sessions, then publish one RemediationCompleted per.
    for i in 0..3 {
        let sid = format!("session-{i}");
        seed_session(&store, &sid);
        daemon.bus.publish(DaemonEvent::RemediationCompleted {
            session_id: sid,
            success:    true,
            summary:    format!("fix attempt #{i}"),
        });
    }

    // Drain — wait until patterns.json reaches success_count = 3.
    let path = patterns_path(repo_dir.path());
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if path.exists() {
            if let Ok(file) = load_patterns(&path) {
                if let Some(p) = file.patterns.iter().find(|p| p.fingerprint == FINGERPRINT) {
                    if p.success_count == 3 { break; }
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            panic!("patterns.json never reached success_count=3 within 2s");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let file = load_patterns(&path).expect("load patterns.json");
    assert_eq!(file.patterns.len(), 1, "exactly one pattern row expected");
    let p = &file.patterns[0];
    assert_eq!(p.fingerprint, FINGERPRINT);
    assert_eq!(p.success_count, 3);
    assert_eq!(p.failure_count, 0);
    assert_eq!(p.kind, PatternKind::AutoDetected);
    assert_eq!(p.evidence.len(), 3);
    assert_eq!(p.evidence[0], "session-0");
    assert_eq!(p.evidence[2], "session-2");
    // First-write summary wins; later successes do not overwrite.
    assert_eq!(p.suggested_fix_summary, "fix attempt #0");

    // Drain the observer for PatternLearned events.
    let mut learned = 0;
    let until = std::time::Instant::now() + Duration::from_millis(200);
    while std::time::Instant::now() < until {
        match observer.try_recv() {
            Ok(DaemonEvent::PatternLearned { fingerprint, success_count, .. })
                if fingerprint == FINGERPRINT =>
            {
                learned += 1;
                let _ = success_count;
            }
            Ok(_)  => {}
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert_eq!(learned, 3, "expected 3 PatternLearned events; got {learned}");

    daemon.shutdown();
    drop(repo_dir); // explicit; test owns the tempdir lifetime
}
