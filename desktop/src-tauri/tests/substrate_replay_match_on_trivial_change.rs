//! Sesión 10 — Test 2: a trivial source-file change against a recent
//! recording produces a `ReplayResult { matched: true }` on the bus.
//!
//! Backend is a closure-driven mock so the test runs without
//! `substrate-v2-replay` on PATH and without the staging endpoint
//! configured (decision logged in `INARI_LIVE_DECISIONS.md` 2026-05-01
//! §"Sesión 10 — mock-vs-real fixture").

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent};
use inariwatch_desktop_lib::sensors::substrate::{
    recordings_root, replay_client::{ReplayBackend, ReplayOutcome}, spawn_with_backend,
};
use inariwatch_desktop_lib::store::{queries, Store};

const REPO_ID: &str = "test-repo-trivial";

struct AlwaysMatch;

impl ReplayBackend for AlwaysMatch {
    fn replay(
        &self,
        _recording_dir: &Path,
        _source_overlay: &Path,
    ) -> std::io::Result<ReplayOutcome> {
        Ok(ReplayOutcome::matched())
    }
    fn name(&self) -> &'static str { "always_match_test_mock" }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trivial_change_emits_match_true() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("fixture-repo");
    std::fs::create_dir_all(&repo).unwrap();

    // Drop a fresh recording on disk — the sensor uses dir mtime as
    // the freshness signal so just creating the directory now is
    // inside the 60s window.
    let recording_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let rec_dir = recordings_root(&repo).join(recording_id);
    std::fs::create_dir_all(&rec_dir).unwrap();
    std::fs::write(rec_dir.join("event-1.json"), b"{}").unwrap();

    // Set up store + register the repo with replay_enabled=true.
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    queries::upsert_repo(&store, REPO_ID, repo.to_str().unwrap(), "fixture-repo", now_ms).unwrap();
    queries::set_repo_replay_enabled(&store, REPO_ID, true).unwrap();

    let daemon = Arc::new(start_daemon());
    let rx = daemon.bus.subscribe();

    let backend: Box<dyn ReplayBackend> = Box::new(AlwaysMatch);
    let _join = spawn_with_backend(Some(backend), daemon.clone(), store.clone());

    // Give the actor a moment to wire up its bus subscription.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Edit a TS file — comment-only level edit.
    let file = repo.join("src").join("handler.ts");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"// trivial change\nexport const ok = true;\n").unwrap();

    daemon.bus.publish(DaemonEvent::FsChange {
        repo_id: REPO_ID.into(),
        path:    file.display().to_string(),
        kind:    inariwatch_desktop_lib::daemon::FsChangeKind::Modified,
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut found = false;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(DaemonEvent::ReplayResult {
                repo_id,
                recording_id: rid,
                matched,
                divergence,
            }) => {
                assert_eq!(repo_id, REPO_ID);
                assert_eq!(rid, recording_id);
                assert!(matched, "expected match=true for trivial change");
                assert!(divergence.is_none(), "no divergence expected");
                found = true;
                break;
            }
            Ok(_)  => continue,
            Err(_) => continue,
        }
    }
    assert!(found, "ReplayResult never published within 5s");

    daemon.shutdown();
    Box::leak(Box::new(dir));
}
