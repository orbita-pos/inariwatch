//! Session 11 — `commit_memory_md` atomically writes the approved
//! content to `.inari/memory.md` AND records a `merge` version row.
//!
//! The atomic-write semantics are: `<path>.tmp` is the staging file,
//! followed by `rename`. Crash-tolerance: even if the process is killed
//! between write+rename, the staging file is identifiable and the
//! original (or absence) is preserved.

use inariwatch_desktop_lib::memory::declarative::{
    atomic_write, latest_memory_version_row, memory_md_path, record_memory_version,
};
use inariwatch_desktop_lib::store::{queries, Store};

#[test]
fn commit_creates_inari_dir_and_writes_memory_md() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo = tmp.path();

    let md = memory_md_path(repo);
    assert!(!md.exists(), "precondition: file must not exist");
    assert!(!md.parent().unwrap().exists(), "precondition: .inari must not exist");

    atomic_write(&md, "# approved memory\n\n## Section [pinned]\n\nbody\n")
        .expect("atomic_write");

    assert!(md.exists(), "memory.md must exist after commit");
    let read_back = std::fs::read_to_string(&md).expect("read");
    assert_eq!(read_back, "# approved memory\n\n## Section [pinned]\n\nbody\n");

    // The .tmp staging file must NOT linger after a successful rename.
    let tmp_path = md.with_extension("md.tmp");
    assert!(!tmp_path.exists(), "staging file must not be left behind");
}

#[test]
fn commit_persists_a_merge_version_row() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    let repo_id = "repo-commit";
    queries::upsert_repo(&store, repo_id, "/tmp/commit-repo", "commit-repo", 1)
        .expect("upsert_repo");

    // Simulate the IPC commit flow: atomic_write + record_memory_version
    // with `written_by = "merge"`.
    let repo_dir = tempfile::tempdir().expect("repo dir");
    let md = memory_md_path(repo_dir.path());
    atomic_write(&md, "approved\n").expect("atomic_write");
    record_memory_version(&store, repo_id, "approved\n", "merge").expect("record");

    let row = latest_memory_version_row(&store, repo_id)
        .expect("lookup")
        .expect("row exists");
    assert_eq!(row.written_by, "merge", "commit path uses 'merge' provenance");
    assert_eq!(row.content, "approved\n");
}

#[test]
fn commit_overwrites_existing_memory_md() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let md = memory_md_path(tmp.path());

    atomic_write(&md, "v1").expect("v1 write");
    atomic_write(&md, "v2").expect("v2 overwrite");

    let read_back = std::fs::read_to_string(&md).expect("read");
    assert_eq!(read_back, "v2", "second write must replace, not append");
}
