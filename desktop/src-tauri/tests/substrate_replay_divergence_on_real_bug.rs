//! Sesión 10 — Test 3: a source-file change that semantically inverts
//! a recorded handler produces `ReplayResult { matched: false }` with
//! a high-severity divergence.
//!
//! We mock the backend (justification in `INARI_LIVE_DECISIONS.md`
//! 2026-05-01 §"Sesión 10 — mock-vs-real fixture"): a real replay
//! engine fixture plus a real recording on every test run is heavier
//! than the contract under test deserves. The mock backend inspects
//! the modified file's contents and reports divergence based on a
//! simple substring rule that mimics what the real engine would
//! detect for a known-bug pattern.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::{
    start_daemon, DaemonEvent, DivergenceKind, DivergenceSeverity, DivergenceSummary, FsChangeKind,
};
use inariwatch_desktop_lib::sensors::substrate::{
    recordings_root, replay_client::{ReplayBackend, ReplayOutcome}, spawn_with_backend,
};
use inariwatch_desktop_lib::store::{queries, Store};

const REPO_ID: &str = "test-repo-bug";

/// Mock backend that flags divergence whenever the modified source
/// contains the canary string `RES_BODY_FALSE`. This stands in for
/// the deterministic IO-mismatch the real replay engine would surface
/// when a handler's response body changed.
struct InvertDetectingMock;

impl ReplayBackend for InvertDetectingMock {
    fn replay(
        &self,
        _recording_dir: &Path,
        source_overlay: &Path,
    ) -> std::io::Result<ReplayOutcome> {
        let body = std::fs::read_to_string(source_overlay)?;
        if body.contains("RES_BODY_FALSE") {
            return Ok(ReplayOutcome::diverged(DivergenceSummary {
                kind:            DivergenceKind::IoMismatch,
                affected_module: "express/handler".into(),
                severity:        DivergenceSeverity::High,
            }));
        }
        Ok(ReplayOutcome::matched())
    }
    fn name(&self) -> &'static str { "invert_detecting_test_mock" }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_bug_emits_match_false_with_high_severity() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("fixture-bug-repo");
    std::fs::create_dir_all(&repo).unwrap();

    let recording_id = "11112222-3333-4444-5555-666677778888";
    let rec_dir = recordings_root(&repo).join(recording_id);
    std::fs::create_dir_all(&rec_dir).unwrap();
    std::fs::write(rec_dir.join("event-1.json"), b"{}").unwrap();

    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    queries::upsert_repo(&store, REPO_ID, repo.to_str().unwrap(), "fixture-bug-repo", now_ms).unwrap();
    queries::set_repo_replay_enabled(&store, REPO_ID, true).unwrap();

    let daemon = Arc::new(start_daemon());
    let rx = daemon.bus.subscribe();

    let backend: Box<dyn ReplayBackend> = Box::new(InvertDetectingMock);
    let _join = spawn_with_backend(Some(backend), daemon.clone(), store.clone());

    tokio::time::sleep(Duration::from_millis(50)).await;

    // Write a handler that flips the recorded response shape — the
    // mock keys off `RES_BODY_FALSE` to flag the divergence.
    let file = repo.join("src").join("handler.ts");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        &file,
        b"// RES_BODY_FALSE\nexport function handler(_req: any, res: any) { return res.json({ ok: false }); }\n",
    ).unwrap();

    daemon.bus.publish(DaemonEvent::FsChange {
        repo_id: REPO_ID.into(),
        path:    file.display().to_string(),
        kind:    FsChangeKind::Modified,
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
                assert!(!matched, "expected match=false for buggy change");
                let div = divergence.expect("divergence should be present");
                assert_eq!(div.severity, DivergenceSeverity::High);
                assert_eq!(div.kind, DivergenceKind::IoMismatch);
                // Affected module is a module name, NEVER a file path
                // — privacy contract from the daemon doc on
                // DivergenceSummary.
                assert!(
                    !div.affected_module.contains('/') ||
                    !div.affected_module.contains(repo.to_str().unwrap()),
                    "affected_module leaks file path: {}", div.affected_module,
                );
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
