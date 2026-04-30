//! Session 11 — `wipe_memory` clears the SQL audit trail and leaves
//! `memory.md` on disk untouched (per the dock spec — "preserves human
//! work").

use inariwatch_desktop_lib::memory::declarative::{
    atomic_write, latest_memory_version_row, memory_md_path, record_memory_version,
    wipe_memory_versions,
};
use inariwatch_desktop_lib::store::{queries, Store};

#[test]
fn wipe_returns_count_and_empties_the_table() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let repo_id = "repo-wipe";
    queries::upsert_repo(&store, repo_id, "/tmp/wipe-repo", "wipe-repo", 1)
        .expect("upsert_repo");

    record_memory_version(&store, repo_id, "v1", "ai").expect("v1");
    record_memory_version(&store, repo_id, "v2", "merge").expect("v2");
    record_memory_version(&store, repo_id, "v3", "merge").expect("v3");

    let removed = wipe_memory_versions(&store, repo_id).expect("wipe");
    assert_eq!(removed, 3, "wipe must report exactly the rows it removed");

    let row = latest_memory_version_row(&store, repo_id).expect("lookup");
    assert!(row.is_none(), "no rows survive the wipe");
}

#[test]
fn wipe_does_not_touch_memory_md_on_disk() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let repo_id = "repo-wipe-disk";
    queries::upsert_repo(&store, repo_id, "/tmp/wipe-disk-repo", "wipe-disk", 1)
        .expect("upsert_repo");

    let repo_dir = tempfile::tempdir().expect("repo dir");
    let md = memory_md_path(repo_dir.path());
    atomic_write(&md, "# human-curated content\n").expect("write memory.md");
    record_memory_version(&store, repo_id, "v1", "human").expect("record");

    wipe_memory_versions(&store, repo_id).expect("wipe");

    assert!(md.exists(), "wipe must NOT delete memory.md");
    let read_back = std::fs::read_to_string(&md).expect("read");
    assert_eq!(read_back, "# human-curated content\n", "content must survive wipe");
}

#[test]
fn wipe_only_affects_the_target_repo() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let repo_a = "repo-a";
    let repo_b = "repo-b";
    queries::upsert_repo(&store, repo_a, "/tmp/repo-a", "a", 1).expect("upsert a");
    queries::upsert_repo(&store, repo_b, "/tmp/repo-b", "b", 1).expect("upsert b");

    record_memory_version(&store, repo_a, "a-v1", "ai").expect("a v1");
    record_memory_version(&store, repo_b, "b-v1", "ai").expect("b v1");

    let removed = wipe_memory_versions(&store, repo_a).expect("wipe a");
    assert_eq!(removed, 1);

    let a = latest_memory_version_row(&store, repo_a).expect("lookup a");
    let b = latest_memory_version_row(&store, repo_b).expect("lookup b");
    assert!(a.is_none(), "repo A wiped");
    assert_eq!(b.unwrap().content, "b-v1", "repo B untouched");
}
