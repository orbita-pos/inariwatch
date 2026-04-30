//! Session 4 — repo open/close exercise the SQL paths the IPC commands
//! use. We don't drive `#[tauri::command]` directly (Tauri 2's
//! `MockBuilder` requires a full app + plugin set we can't spin up
//! cheaply on Windows) — instead we hit the underlying queries through
//! the public `Store` surface, which is *exactly* what the commands
//! call after parameter validation.
//!
//! The test asserts:
//! - inserting a fresh repo lands a row + cascades on delete
//! - re-opening the same path is idempotent (same id returned)
//! - close removes the row and any child events

use inariwatch_desktop_lib::store::{queries, Store};
use rusqlite::params;

fn fresh_store() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let db = tmp.path().join("inari-live").join("store.db");
    let store = Store::open_at(&db).expect("open store");
    (tmp, store)
}

#[test]
fn open_repo_inserts_and_lookup_returns_same_id() {
    let (_tmp, store) = fresh_store();

    let id1 = queries::upsert_repo(&store, "abc-123", "/tmp/repoA", "repoA", 100)
        .expect("upsert");
    assert_eq!(id1, "abc-123");

    // Same path → same id (idempotent upsert).
    let id2 = queries::upsert_repo(&store, "ignored-new-id", "/tmp/repoA", "repoA", 200)
        .expect("upsert again");
    assert_eq!(id2, "abc-123", "second upsert must reuse the existing id");

    // find_repo_by_path resolves it.
    let found = queries::find_repo_by_path(&store, "/tmp/repoA")
        .expect("find");
    assert_eq!(found.as_deref(), Some("abc-123"));
}

#[test]
fn close_repo_cascades_to_events() {
    let (_tmp, store) = fresh_store();

    queries::upsert_repo(&store, "repo-1", "/tmp/repoB", "repoB", 100).expect("upsert");
    queries::insert_event(&store, 200, "test_event", Some("repo-1"), "{}").expect("event");
    queries::insert_event(&store, 300, "test_event", Some("repo-1"), "{}").expect("event");

    // Confirm there are 2 child events.
    let events_before: i64 = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE repo_id = ?1",
            params!["repo-1"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(events_before, 2);

    // close_repo's body — same DELETE the IPC command runs.
    let n = store
        .conn()
        .unwrap()
        .execute("DELETE FROM repos WHERE id = ?1", params!["repo-1"])
        .expect("delete");
    assert_eq!(n, 1);

    let events_after: i64 = store
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE repo_id = ?1",
            params!["repo-1"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(events_after, 0, "FK ON DELETE CASCADE must wipe child events");

    // Repo row is gone.
    assert!(queries::find_repo_by_path(&store, "/tmp/repoB")
        .unwrap()
        .is_none());
}

#[test]
fn close_repo_returns_zero_when_id_unknown() {
    let (_tmp, store) = fresh_store();
    let n = store
        .conn()
        .unwrap()
        .execute("DELETE FROM repos WHERE id = ?1", params!["does-not-exist"])
        .expect("delete");
    assert_eq!(n, 0, "deleting an unknown id must return 0 affected rows");
}
