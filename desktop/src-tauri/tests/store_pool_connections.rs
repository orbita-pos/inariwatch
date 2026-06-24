//! Concurrent acquires from the pool deliver connections that all have
//! the per-connection PRAGMAs applied. This is the regression test for
//! the on_acquire hook running on EVERY pooled connection (not just
//! the first one).

use std::sync::Arc;
use std::thread;

use inariwatch_desktop_lib::store::{pool::POOL_SIZE, Store};
use rusqlite::params;

#[test]
fn four_concurrent_threads_all_see_pragmas_and_can_write() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).expect("open"));

    let mut handles = Vec::new();
    for tid in 0..POOL_SIZE {
        let store = store.clone();
        let h = thread::spawn(move || {
            // Every thread acquires its own connection, holds it for
            // the duration of the work, and verifies PRAGMAs + writes
            // a row to prove the FK and writability are functional.
            let conn = store.conn().expect("acquire");

            let fk: i64 = conn
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .unwrap();
            assert_eq!(fk, 1, "thread {tid} saw foreign_keys off");

            let journal: String = conn
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            assert_eq!(journal.to_lowercase(), "wal", "thread {tid} not in WAL");

            // Repo rows are unique on `path` so each thread writes a
            // distinct path. Tests the write path through a pooled
            // connection (not just reads).
            let id = format!("repo-thread-{tid}");
            let path = format!("/tmp/repo-thread-{tid}");
            conn.execute(
                "INSERT INTO repos (id, path, name, opened_at, indexed_file_count)
                 VALUES (?1, ?2, ?3, ?4, 0)",
                params![id, path, format!("thread-{tid}"), 1_700_000_000_i64],
            )
            .expect("insert");
        });
        handles.push(h);
    }

    for h in handles {
        h.join().expect("thread panicked");
    }

    // All POOL_SIZE rows landed.
    let conn = store.conn().expect("final acquire");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM repos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, POOL_SIZE as i64);
}

#[test]
fn foreign_key_cascade_is_enforced() {
    // Cascading delete proves foreign_keys is actually applied (a
    // `PRAGMA` reading "1" can lie if statement_executor caches a
    // pre-pragma plan; this test exercises the runtime behaviour).
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let conn = store.conn().expect("conn");

    conn.execute(
        "INSERT INTO repos (id, path, name, opened_at, indexed_file_count)
         VALUES ('r1', '/tmp/r1', 'r1', 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO events (timestamp, kind, repo_id, payload)
         VALUES (1, 'test', 'r1', '{}')",
        [],
    )
    .unwrap();

    let events_before: i64 = conn
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(events_before, 1);

    conn.execute("DELETE FROM repos WHERE id = 'r1'", []).unwrap();

    let events_after: i64 = conn
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(events_after, 0, "cascade delete should have wiped the event");
}
