//! WAL mode + the rest of the per-connection PRAGMAs are applied on
//! every fresh acquire from the pool.

use inariwatch_desktop_lib::store::Store;

#[test]
fn pragmas_present_on_first_connection() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let conn = store.conn().expect("conn");

    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal_mode");
    assert_eq!(journal.to_lowercase(), "wal");

    let synchronous: i64 = conn
        .query_row("PRAGMA synchronous", [], |row| row.get(0))
        .expect("synchronous");
    // 1 = NORMAL.
    assert_eq!(synchronous, 1);

    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .expect("foreign_keys");
    assert_eq!(foreign_keys, 1);

    let busy_timeout: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .expect("busy_timeout");
    assert_eq!(busy_timeout, 5_000);

    let temp_store: i64 = conn
        .query_row("PRAGMA temp_store", [], |row| row.get(0))
        .expect("temp_store");
    // 2 = MEMORY.
    assert_eq!(temp_store, 2);
}

#[test]
fn pragmas_present_after_drop_and_reacquire() {
    // foreign_keys is connection-local; the customizer must reapply
    // it on every acquire, not only on first open. Drop a connection
    // and re-grab one; foreign_keys should still be ON.
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    {
        let conn = store.conn().expect("conn 1");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fk, 1);
    }

    // Re-acquire — same pooled connection (in single-thread tests
    // r2d2 will hand out the same one). The PRAGMA is still on
    // because the customizer applied it on the first acquire and
    // foreign_keys is sticky for the connection's lifetime.
    let conn = store.conn().expect("conn 2");
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();
    assert_eq!(fk, 1);
}
