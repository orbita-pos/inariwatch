//! Sesión 13 — episodic memory layer.
//!
//! Spawns the event persister against a real bus + store, publishes a
//! handful of representative events, and asserts only the persistable
//! subset lands in the `events` table. Specifically validates that
//! `ChatTokenStream` and `MemoryReviewRequested` are dropped on the
//! floor (per the policy table in `memory/episodic/mod.rs`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::{
    start_daemon, DaemonEvent, FsChangeKind, MemoryKind,
};
use inariwatch_desktop_lib::memory::episodic::{query, spawn_event_persister, EventFilter};
use inariwatch_desktop_lib::store::queries::{count_events_by_kind, upsert_repo};
use inariwatch_desktop_lib::store::Store;

const REPO_ID: &str = "repo-episodic";

fn open_store() -> Arc<Store> {
    let dir   = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("episodic.db")).expect("open store"),
    );
    std::mem::forget(dir);
    store
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persists_only_the_documented_subset() {
    let store  = open_store();
    upsert_repo(&store, REPO_ID, "/tmp/repo-episodic", "episodic", 0).unwrap();
    let daemon = Arc::new(start_daemon());

    // Spawn persister BEFORE publishing so we don't race the
    // subscriber registration.
    let _persister = spawn_event_persister(daemon.clone(), store.clone());
    // Tiny grace so the subscribe call inside the persister has run.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // 2× FsChange (persisted)
    daemon.bus.publish(DaemonEvent::FsChange {
        repo_id: REPO_ID.to_string(),
        path:    "src/lib.rs".into(),
        kind:    FsChangeKind::Modified,
    });
    daemon.bus.publish(DaemonEvent::FsChange {
        repo_id: REPO_ID.to_string(),
        path:    "src/main.rs".into(),
        kind:    FsChangeKind::Created,
    });
    // 1× ShellEvent (persisted, repo_id NULL)
    daemon.bus.publish(DaemonEvent::ShellEvent {
        session_id:  "shell-1".into(),
        cmd:         "cargo build".into(),
        cwd:         PathBuf::from("/tmp/repo-episodic"),
        exit_code:   0,
        duration_ms: 10,
        timestamp:   42,
    });
    // 1× ChatTokenStream (DROPPED — chat token spam)
    daemon.bus.publish(DaemonEvent::ChatTokenStream {
        session_id:    "chat-1".into(),
        token:         "hello".into(),
        finish_reason: None,
    });
    // 1× MemoryReviewRequested (DROPPED — UI signal)
    daemon.bus.publish(DaemonEvent::MemoryReviewRequested {
        repo_id: REPO_ID.to_string(),
        kind:    MemoryKind::Initial,
    });

    // Drain window — bus delivery is async + the persister's INSERT
    // is synchronous so a generous bound is enough.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut counts;
    loop {
        counts = count_events_by_kind(&store).expect("count_events_by_kind");
        let total: u64 = counts.values().sum();
        if total >= 3 || std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert_eq!(counts.get("fs_change").copied().unwrap_or(0), 2,
        "expected 2 fs_change rows, got {:?}", counts);
    assert_eq!(counts.get("shell_event").copied().unwrap_or(0), 1,
        "expected 1 shell_event row, got {:?}", counts);
    assert!(counts.get("chat_token_stream").is_none(),
        "ChatTokenStream must NOT persist; got {:?}", counts);
    assert!(counts.get("memory_review_requested").is_none(),
        "MemoryReviewRequested must NOT persist; got {:?}", counts);

    // Total persisted = 3 (2 fs + 1 shell). Anything else means we
    // accidentally persisted a UI / ephemeral event.
    let total: u64 = counts.values().sum();
    assert_eq!(total, 3, "exactly 3 rows should persist; got {:?}", counts);

    // Filtered query — fs_change rows by kind.
    let fs_rows = query(&store, &EventFilter {
        kind: Some("fs_change"),
        ..Default::default()
    })
    .expect("query fs_change");
    assert_eq!(fs_rows.len(), 2);
    for row in &fs_rows {
        assert_eq!(row.kind, "fs_change");
        assert_eq!(row.repo_id.as_deref(), Some(REPO_ID));
    }

    // Filtered query — shell_event has NULL repo_id (no repo context).
    let shell_rows = query(&store, &EventFilter {
        kind: Some("shell_event"),
        ..Default::default()
    })
    .expect("query shell_event");
    assert_eq!(shell_rows.len(), 1);
    assert!(shell_rows[0].repo_id.is_none(), "shell_event repo_id should be NULL");

    daemon.shutdown();
}
