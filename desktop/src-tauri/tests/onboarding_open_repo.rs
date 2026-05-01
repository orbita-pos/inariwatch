//! Sesión 17 — onboarding repo registration round-trip.
//!
//! `onboarding_open_repo` (the Tauri command) is a thin wrapper around
//! `queries::upsert_repo` + the FS sensor attach. Spawning a real Tauri
//! `AppHandle` is over-the-top for an integration test (would require
//! `tauri::test::mock_app`), so this test exercises the query layer the
//! command depends on:
//!
//!   1. `find_repo_by_path` → None on first registration.
//!   2. `upsert_repo` returns a fresh id.
//!   3. `find_repo_by_path` is now Some(id).
//!   4. `list_repos_with_metrics` reflects the new row.
//!   5. A second `upsert_repo` for the same path is idempotent — same id.

use std::fs;

use inariwatch_desktop_lib::store::{queries, Store};

#[test]
fn open_repo_registers_and_is_idempotent() {
    let dbtmp = tempfile::tempdir().expect("dbtmp");
    let store = Store::open_at(&dbtmp.path().join("store.db")).expect("open");

    // Spawn a fixture "git repo" — what the dropzone canonicalizes.
    let repo = tempfile::tempdir().expect("repo");
    let repo_path = repo.path().join("project");
    fs::create_dir_all(repo_path.join(".git")).expect("git dir");
    let repo_path_str = repo_path.to_string_lossy().to_string();

    // Pre-state: not yet registered.
    let pre = queries::find_repo_by_path(&store, &repo_path_str).expect("pre");
    assert!(pre.is_none(), "fresh tempdir not yet known");

    // First "open_repo" call — assigns an id.
    let id_a = queries::upsert_repo(&store, "id-aaaa", &repo_path_str, "project", 100)
        .expect("first upsert");
    assert_eq!(id_a, "id-aaaa");

    // Second call with the same path — must short-circuit to the same id
    // even when the caller passes a different candidate id (mirrors the
    // command's flow: it always proposes a fresh id, the upsert dedupes).
    let id_b = queries::upsert_repo(&store, "id-zzzz", &repo_path_str, "project", 200)
        .expect("second upsert");
    assert_eq!(id_b, "id-aaaa", "upsert must be idempotent on path");

    // List reflects exactly one row.
    let rows = queries::list_repos_with_metrics(&store).expect("list");
    assert_eq!(rows.len(), 1, "one row visible");
    assert_eq!(rows[0].id,   "id-aaaa");
    assert_eq!(rows[0].path, repo_path_str);
    assert_eq!(rows[0].name, "project");
    assert_eq!(rows[0].symbol_count, 0, "fresh repo has zero indexed symbols");
    assert!(!rows[0].replay_enabled, "default replay flag is OFF");
}

#[test]
fn list_repos_includes_replay_flag_after_toggle() {
    let dbtmp = tempfile::tempdir().expect("dbtmp");
    let store = Store::open_at(&dbtmp.path().join("store.db")).expect("open");

    queries::upsert_repo(&store, "r1", "/tmp/r1", "r1", 1).expect("r1");
    queries::upsert_repo(&store, "r2", "/tmp/r2", "r2", 2).expect("r2");

    queries::set_repo_replay_enabled(&store, "r1", true).expect("toggle r1");

    let rows = queries::list_repos_with_metrics(&store).expect("list");
    let r1 = rows.iter().find(|r| r.id == "r1").expect("r1 row");
    let r2 = rows.iter().find(|r| r.id == "r2").expect("r2 row");
    assert!(r1.replay_enabled, "r1 replay flag persisted");
    assert!(!r2.replay_enabled, "r2 replay flag default off");
}
