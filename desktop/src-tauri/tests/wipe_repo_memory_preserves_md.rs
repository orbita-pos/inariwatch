//! Sesión 17 — `wipe_repo_index` drops cache rows but preserves
//! `memory_md_versions` (the "memory" the user authored).
//!
//! This is the contract behind the Settings → Repos → "Wipe memory"
//! confirmation dialog. The dialog copy promises:
//!   "This will delete the index for <repo>. Your memory.md will be preserved."
//!
//! The IPC `wipe_repo_memory` is a thin wrapper over
//! `queries::wipe_repo_index`; this test exercises the underlying
//! invariant directly.

use rusqlite::params;

use inariwatch_desktop_lib::store::{queries, Store};

#[test]
fn wipe_drops_index_rows_but_keeps_memory_md_versions() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    let repo_id = "wipe-repo-id";
    queries::upsert_repo(&store, repo_id, "/tmp/wipe-repo", "wipe-repo", 1)
        .expect("upsert_repo");

    // Populate the cache-shaped tables. We hand-roll inserts here rather
    // than going through the indexer — the tests for those primitives
    // already cover their semantics; here we just need rows to delete.
    let conn = store.conn().expect("conn");
    let symbol_id: i64 = {
        conn.execute(
            "INSERT INTO code_symbols (repo_id, file_path, symbol_name, kind, line_start, line_end, ast_hash)
             VALUES (?1, 'src/foo.ts', 'fooFn', 'function', 1, 10, 'sha-aaa')",
            params![repo_id],
        )
        .expect("insert symbol");
        conn.last_insert_rowid()
    };
    // 384-dim float embedding — encode as little-endian f32 bytes.
    let bytes: Vec<u8> = (0..384u32)
        .flat_map(|i| (i as f32).to_le_bytes())
        .collect();
    conn.execute(
        "INSERT INTO code_embeddings (symbol_id, embedding) VALUES (?1, ?2)",
        params![symbol_id, bytes],
    )
    .expect("insert embedding");

    queries::insert_event(&store, 100, "fs_change", Some(repo_id), "{}").expect("ev1");
    queries::insert_event(&store, 200, "shell_event", Some(repo_id), "{}").expect("ev2");

    conn.execute(
        "INSERT INTO patterns (repo_id, pattern_kind, fingerprint, evidence,
                               success_count, failure_count, last_seen_at)
         VALUES (?1, 'auto-detected', 'fp-1', '[]', 1, 0, 1)",
        params![repo_id],
    )
    .expect("pattern");

    // Memory.md audit row — MUST survive the wipe.
    queries::insert_memory_md_version(&store, repo_id, "# memory v1", "human", 1)
        .expect("md version");

    drop(conn);

    let counts = queries::wipe_repo_index(&store, repo_id).expect("wipe");
    assert_eq!(counts.symbols, 1, "1 symbol dropped");
    assert_eq!(counts.embeddings, 1, "1 embedding dropped");
    assert_eq!(counts.events, 2, "2 events dropped");
    assert_eq!(counts.patterns, 1, "1 pattern dropped");

    // Verify the cache-shaped rows are actually gone.
    let conn = store.conn().expect("conn");
    let symbol_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM code_symbols WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .expect("count symbols");
    let embedding_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM code_embeddings", [], |r| r.get(0))
        .expect("count embeddings");
    let event_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .expect("count events");
    let pattern_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM patterns WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .expect("count patterns");

    assert_eq!(symbol_count, 0);
    assert_eq!(embedding_count, 0);
    assert_eq!(event_count, 0);
    assert_eq!(pattern_count, 0);

    // Memory MD survives — the human work IS preserved.
    let md = queries::latest_memory_md_version(&store, repo_id)
        .expect("query md")
        .expect("md row survives wipe");
    assert_eq!(md.content, "# memory v1");
    assert_eq!(md.written_by, "human");
}

#[test]
fn wipe_only_affects_target_repo() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    queries::upsert_repo(&store, "repo-a", "/tmp/repo-a", "a", 1).expect("a");
    queries::upsert_repo(&store, "repo-b", "/tmp/repo-b", "b", 1).expect("b");

    queries::insert_event(&store, 1, "fs_change", Some("repo-a"), "{}").expect("ev a");
    queries::insert_event(&store, 1, "fs_change", Some("repo-b"), "{}").expect("ev b");

    let counts = queries::wipe_repo_index(&store, "repo-a").expect("wipe");
    assert_eq!(counts.events, 1);

    let conn = store.conn().expect("conn");
    let b_events: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE repo_id = 'repo-b'",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(b_events, 1, "repo-b events untouched");
}

#[test]
fn wipe_unknown_repo_id_is_a_zero_count_noop() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let store = Store::open_at(&tmp.path().join("store.db")).expect("open");

    let counts = queries::wipe_repo_index(&store, "nope-not-a-repo").expect("wipe");
    assert_eq!(counts.symbols, 0);
    assert_eq!(counts.embeddings, 0);
    assert_eq!(counts.events, 0);
    assert_eq!(counts.patterns, 0);
}
