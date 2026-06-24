//! Session 11 — proposing a `memory.md` update inserts a new row in
//! `memory_md_versions` (it does NOT touch the on-disk file).
//!
//! The IPC `propose_memory_md_update` is a thin wrapper that:
//!   1. validates the 1MB cap,
//!   2. resolves the repo,
//!   3. calls `memory::declarative::record_memory_version` with
//!      `written_by = "ai_proposed"`,
//!   4. publishes `MemoryReviewRequested` on the daemon bus.
//!
//! This test covers (3) — the core invariant. (4) is covered by
//! `memory_md_review_event_emitted.rs`.

use inariwatch_desktop_lib::memory::declarative::{
    latest_memory_version_row, record_memory_version,
};
use inariwatch_desktop_lib::store::{queries, Store};

#[test]
fn proposal_appends_a_version_row_with_ai_proposed_provenance() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    // Register a repo so the FK constraint on memory_md_versions(repo_id)
    // is satisfied. `upsert_repo` is the same path the IPC `open_repo`
    // command uses.
    let repo_id = "repo-propose";
    queries::upsert_repo(&store, repo_id, "/tmp/proposal-repo", "proposal-repo", 1)
        .expect("upsert_repo");

    // Initially: no versions for this repo.
    let none = latest_memory_version_row(&store, repo_id).expect("first lookup");
    assert!(none.is_none(), "fresh repo must have no version rows");

    let id = record_memory_version(&store, repo_id, "# proposed memory\n", "ai_proposed")
        .expect("record_memory_version");
    assert!(id > 0, "rowid must be positive");

    let row = latest_memory_version_row(&store, repo_id)
        .expect("post-insert lookup")
        .expect("row exists");
    assert_eq!(row.id, id);
    assert_eq!(row.repo_id, repo_id);
    assert_eq!(row.content, "# proposed memory\n");
    assert_eq!(row.written_by, "ai_proposed");
    assert!(row.written_at > 0);
}

#[test]
fn second_proposal_supersedes_the_first_in_latest_lookup() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    let repo_id = "repo-propose-twice";
    queries::upsert_repo(&store, repo_id, "/tmp/proposal-repo-2", "p2", 1)
        .expect("upsert_repo");

    record_memory_version(&store, repo_id, "v1", "ai_proposed").expect("v1");
    // Strict monotonic written_at requires a tick; use the lower-level
    // queries helper to control the timestamp directly so the test
    // doesn't depend on wall clock.
    queries::insert_memory_md_version(&store, repo_id, "v2", "ai_proposed", 2_000)
        .expect("v2");

    let row = latest_memory_version_row(&store, repo_id)
        .expect("lookup")
        .expect("row exists");
    assert_eq!(row.content, "v2", "latest must follow written_at DESC");
}
