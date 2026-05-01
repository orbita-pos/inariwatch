//! Sesión 12 — failure-majority demote path.
//!
//! Original prompt asked for `procedural_demotes_to_anti_pattern.rs`
//! covering both count-majority demote AND forced demote (via
//! `RegressionDetected`). The forced-demote path is deferred — no
//! emitter exists in S19/S20 (see DECISIONS 2026-05-01 "Sesión 12 —
//! RegressionDetected variant deferred"). This test covers the count
//! path only; `learner.rs::tests::forced_demote_overrides_count_majority`
//! covers the forced path at the unit level.
//!
//! Scenario:
//!   * 1× `RemediationCompleted { success: true, .. }` for FP_Y → success_count=1
//!   * 5× `FixRejected` for the same FP_Y          → failure_count=5
//!   * Pattern demoted to AntiPattern after the second failure
//!     (failure_count=2 > success_count=1).
//!   * Exactly 1× `PatternDemoted` event with `reason="failure_majority"`.

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

const REPO_ID:     &str = "repo-procedural-demote";
const FINGERPRINT: &str = "fp_y_wrong_diagnosis";

fn open_store_and_repo() -> (Arc<Store>, tempfile::TempDir) {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("inari.db")).expect("open store"),
    );
    let repo_path = dir.path().to_string_lossy().into_owned();
    upsert_repo(&store, REPO_ID, &repo_path, "demote-test", 0).unwrap();
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
            error_message:     Some("Wrong diagnosis class"),
            created_at_ms:     0,
        },
    )
    .expect("seed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn five_rejections_after_one_success_demote_to_anti_pattern() {
    let (store, repo_dir) = open_store_and_repo();
    let daemon = Arc::new(start_daemon());

    let observer = daemon.bus.subscribe();
    let _learner = spawn_pattern_learner(daemon.clone(), store.clone());
    tokio::time::sleep(Duration::from_millis(50)).await;

    // 1× success
    {
        let sid = "ok-1".to_string();
        seed_session(&store, &sid);
        daemon.bus.publish(DaemonEvent::RemediationCompleted {
            session_id: sid,
            success:    true,
            summary:    "the only success".to_string(),
        });
    }
    // 5× rejection
    for i in 0..5 {
        let sid = format!("rej-{i}");
        seed_session(&store, &sid);
        daemon.bus.publish(DaemonEvent::FixRejected {
            session_id: sid,
            reason:     Some(format!("user rejected #{i}")),
        });
    }

    let path = patterns_path(repo_dir.path());
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if path.exists() {
            if let Ok(file) = load_patterns(&path) {
                if let Some(p) = file.patterns.iter().find(|p| p.fingerprint == FINGERPRINT) {
                    if p.failure_count == 5 { break; }
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            panic!("patterns.json never reached failure_count=5 within 2s");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let file = load_patterns(&path).expect("load patterns.json");
    let p = file
        .patterns
        .iter()
        .find(|p| p.fingerprint == FINGERPRINT)
        .expect("pattern row");
    assert_eq!(p.success_count, 1);
    assert_eq!(p.failure_count, 5);
    assert_eq!(p.kind, PatternKind::AntiPattern, "5 > 1 must demote");

    // Drain observer — exactly 1 PatternDemoted (the moment failure
    // crossed success: 1 vs 1 = no demote, 1 vs 2 = demote, then 1
    // vs 3..5 = already demoted, no further demote events).
    let mut demoted = 0;
    let until = std::time::Instant::now() + Duration::from_millis(200);
    while std::time::Instant::now() < until {
        match observer.try_recv() {
            Ok(DaemonEvent::PatternDemoted {
                fingerprint, prior_success, new_failure, reason, ..
            }) if fingerprint == FINGERPRINT => {
                demoted += 1;
                assert_eq!(reason, "failure_majority");
                assert_eq!(prior_success, 1);
                assert_eq!(new_failure, 2);
            }
            Ok(_)  => {}
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert_eq!(demoted, 1, "exactly one PatternDemoted expected; got {demoted}");

    daemon.shutdown();
    drop(repo_dir);
}
