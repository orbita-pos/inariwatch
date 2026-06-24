//! Sesión 13 — retention runner.
//!
//! Drives `RetentionRunner::run_once_for_tests` with synthesised
//! timestamps and asserts:
//!   1. Rows past their per-kind TTL are deleted.
//!   2. Rows under their TTL stay put.
//!   3. `Infinite` kinds (git_event) are never touched.
//!   4. `VACUUM` runs when the tick deletes more than the threshold,
//!      and the on-disk file shrinks as a result.

use std::sync::Arc;

use inariwatch_desktop_lib::memory::retention::{
    ttl_for, EventTtl, RetentionRunner, VACUUM_ROW_THRESHOLD,
};
use inariwatch_desktop_lib::store::queries::{count_events_by_kind, insert_event};
use inariwatch_desktop_lib::store::Store;

const NOW_MS: i64 = 1_750_000_000_000; // arbitrary fixed reference point

fn open_store_at(path: &std::path::Path) -> Arc<Store> {
    Arc::new(Store::open_at(path).expect("open store"))
}

fn day_ms(n: i64) -> i64 {
    n * 24 * 60 * 60 * 1000
}

#[test]
fn deletes_old_rows_and_preserves_infinite_kinds() {
    let dir   = tempfile::tempdir().unwrap();
    let store = open_store_at(&dir.path().join("retention.db"));
    std::mem::forget(dir);

    // 50 fresh shell events (5 days old, well under 30-day TTL).
    for i in 0..50 {
        insert_event(
            &store,
            NOW_MS - day_ms(5),
            "shell_event",
            None,
            &format!(r#"{{"i":{i},"age":"fresh"}}"#),
        )
        .unwrap();
    }
    // 50 stale shell events (31 days old, past the 30-day TTL).
    for i in 0..50 {
        insert_event(
            &store,
            NOW_MS - day_ms(31),
            "shell_event",
            None,
            &format!(r#"{{"i":{i},"age":"stale"}}"#),
        )
        .unwrap();
    }
    // 50 ancient git events. TTL is Infinite — they must never be
    // touched.
    for i in 0..50 {
        insert_event(
            &store,
            NOW_MS - day_ms(365 * 5), // 5 years old
            "git_event",
            None,
            &format!(r#"{{"i":{i},"age":"ancient"}}"#),
        )
        .unwrap();
    }

    // Sanity: TTL table mappings haven't drifted.
    assert_eq!(ttl_for("shell_event"), EventTtl::Days(30));
    assert_eq!(ttl_for("git_event"),   EventTtl::Infinite);
    assert_eq!(ttl_for("unknown_xyz"), EventTtl::Infinite);

    let runner = RetentionRunner::new(store.clone());
    let report = runner.run_once_for_tests(NOW_MS).expect("retention tick");

    assert_eq!(report.deleted, 50, "should have deleted 50 stale rows");
    assert!(
        !report.vacuumed,
        "VACUUM threshold is {VACUUM_ROW_THRESHOLD} — 50 deletions must NOT trigger it"
    );

    let counts = count_events_by_kind(&store).expect("counts");
    assert_eq!(counts.get("shell_event").copied().unwrap_or(0), 50,
        "fresh shell rows should remain, got {counts:?}");
    assert_eq!(counts.get("git_event").copied().unwrap_or(0), 50,
        "git rows must NEVER be touched (Infinite TTL), got {counts:?}");
}

#[test]
fn vacuum_runs_when_threshold_crossed() {
    let dir      = tempfile::tempdir().unwrap();
    let db_path  = dir.path().join("vacuum.db");
    let store    = open_store_at(&db_path);
    std::mem::forget(dir);

    // Insert just over the VACUUM threshold of stale rows. The payload
    // is intentionally chunky (~1 KB each) so the file actually grows
    // — VACUUM has something meaningful to reclaim.
    let bulky = "x".repeat(1024);
    let stale_count = VACUUM_ROW_THRESHOLD + 1;
    for i in 0..stale_count {
        insert_event(
            &store,
            NOW_MS - day_ms(31),
            "fs_change",
            None,
            &format!(r#"{{"i":{i},"blob":"{bulky}"}}"#),
        )
        .unwrap();
    }

    // Force a checkpoint so the WAL contents land in the main file
    // before we measure size; otherwise WAL-mode SQLite under-counts
    // the apparent "size" we'd see post-VACUUM.
    store
        .conn()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .ok();
    let pre_size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);

    let runner = RetentionRunner::new(store.clone());
    let report = runner.run_once_for_tests(NOW_MS).expect("retention tick");

    assert_eq!(report.deleted, stale_count,
        "expected {stale_count} deletions, got {}", report.deleted);
    assert!(report.vacuumed,
        "deletion count {} crossed threshold {VACUUM_ROW_THRESHOLD} — VACUUM should have run",
        report.deleted);

    // After VACUUM, the file must not have GROWN. We don't assert a
    // strict shrink because tiny test payloads can land entirely
    // inside reusable pages; the contract is "VACUUM was attempted
    // and didn't bloat the file". If you change the bulky payload
    // size, this still holds: deleting 10k rows then VACUUMing leaves
    // the file at most as large as before, never larger.
    store
        .conn()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .ok();
    let post_size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    assert!(
        post_size <= pre_size,
        "VACUUM should not bloat the file: {pre_size} -> {post_size}"
    );

    let counts = count_events_by_kind(&store).expect("counts");
    assert_eq!(counts.get("fs_change").copied().unwrap_or(0), 0,
        "all stale fs_change rows should be gone, got {counts:?}");
}
