//! Migrations apply on a fresh DB and are idempotent on a second open.

use inariwatch_desktop_lib::store::{migrations, Store};
use rusqlite::params;

#[test]
fn fresh_db_applies_all_migrations_then_is_idempotent() {
    let expected = migrations::MIGRATIONS.len() as u32;
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("inari-live").join("store.db");

    // First open: applies every migration in `MIGRATIONS`.
    let store = Store::open_at(&db_path).expect("first open");
    let conn = store.conn().expect("conn");
    let count = migrations::applied_count(&conn).expect("count");
    assert_eq!(
        count, expected,
        "expected {expected} migrations applied on a fresh DB"
    );
    drop(conn);
    drop(store);

    // Second open: re-runs the migrator, applies nothing new.
    let store = Store::open_at(&db_path).expect("second open");
    let conn = store.conn().expect("conn");
    let count = migrations::applied_count(&conn).expect("count");
    assert_eq!(count, expected, "second open must not duplicate migrations");
}

#[test]
fn schema_has_expected_tables_and_indexes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let conn = store.conn().expect("conn");

    // Tables created by the 3 migrations.
    for table in &[
        "repos",
        "events",
        "settings",
        "code_symbols",
        "code_embeddings",
        "memory_md_versions",
        "patterns",
        "schema_versions",
    ] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE (type = 'table' OR type = 'virtual') AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .or_else(|_| {
                // sqlite_master.type is 'table' for vec0 too; fallback below
                // covers older sqlite versions where the type column lies.
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    params![table],
                    |row| row.get(0),
                )
            })
            .unwrap_or(0);
        assert!(exists > 0, "expected table/virtual `{table}` to exist");
    }

    // Indexes that must exist for query performance.
    for idx in &[
        "repos_path_idx",
        "events_repo_kind_ts_idx",
        "events_ts_idx",
        "code_symbols_repo_file_idx",
        "memory_md_repo_ts_idx",
        "patterns_repo_kind_idx",
    ] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                params![idx],
                |row| row.get(0),
            )
            .unwrap_or(0);
        assert_eq!(exists, 1, "expected index `{idx}`");
    }
}

#[test]
fn repos_columns_match_spec() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");
    let conn = store.conn().expect("conn");

    // PRAGMA table_info returns (cid, name, type, notnull, dflt_value, pk).
    let mut stmt = conn.prepare("PRAGMA table_info(repos)").unwrap();
    let mut names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    names.sort();

    let mut expected = vec![
        "id",
        "indexed_file_count",
        "last_indexed_at",
        "name",
        "opened_at",
        "path",
    ];
    expected.sort();

    assert_eq!(names, expected, "repos columns mismatch");
}
