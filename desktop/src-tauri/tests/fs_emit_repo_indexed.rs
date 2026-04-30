//! Initial walk publishes a `RepoIndexed` event with the correct count.

use std::path::Path;

use inariwatch_desktop_lib::daemon::{DaemonEvent, EventBus};
use inariwatch_desktop_lib::sensors::fs::watcher::walk_and_publish;

#[test]
fn walk_and_publish_emits_repo_indexed_with_correct_count() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    write_file(&root.join("a.txt"), b"x");
    write_file(&root.join("b.txt"), b"y");
    write_file(&root.join("c.txt"), b"z");

    let bus = EventBus::new();
    let rx  = bus.subscribe();

    walk_and_publish(bus.clone(), "repo-fixture-1".to_string(), root.to_path_buf());

    // Walker runs synchronously here (test helper bypasses the rayon
    // spawn). One event should be queued.
    let event = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("RepoIndexed must arrive within 5s");

    match event {
        DaemonEvent::RepoIndexed { repo_id, file_count, duration_ms } => {
            assert_eq!(repo_id, "repo-fixture-1");
            assert_eq!(file_count, 3, "3 files were created in the fixture");
            // duration_ms is wall-clock; floor at 0 (some runs measure
            // <1ms and round to 0).
            assert!(duration_ms < 30_000, "walk took {}ms — exceeds 30s budget", duration_ms);
        }
        other => panic!("expected RepoIndexed, got {:?}", other),
    }
}

#[test]
fn walk_and_publish_zero_files_emits_zero_count() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let bus = EventBus::new();
    let rx  = bus.subscribe();
    walk_and_publish(bus.clone(), "empty-repo".to_string(), tmp.path().to_path_buf());

    let ev = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("RepoIndexed");
    if let DaemonEvent::RepoIndexed { file_count, .. } = ev {
        assert_eq!(file_count, 0);
    } else {
        panic!("expected RepoIndexed");
    }
}

fn write_file(p: &Path, bytes: &[u8]) {
    std::fs::write(p, bytes).expect("write");
}
