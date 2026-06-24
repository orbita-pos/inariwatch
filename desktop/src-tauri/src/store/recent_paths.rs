//! Recent-paths ring buffer — drives the Phase 5.6 PathPickerSlot.
//!
//! Stores the absolute repo paths the user has recently passed to
//! `/install` (and other path-shaped slash flows). The picker reads
//! the top N by recency; the install handler calls `touch` on each
//! successful invocation.
//!
//! Capacity is enforced at write time: after each `touch`, rows
//! beyond the cap are deleted by `last_used_at` ascending. The cap
//! is a constant rather than an env var because (a) it directly
//! affects picker UX and (b) we want the picker to fit on one screen
//! without paging.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::error::Result;
use super::Store;

/// Maximum rows kept on disk. Eviction runs on every `touch`.
const MAX_ENTRIES: usize = 20;

/// One row in the recent-paths buffer. `last_used_at` is unix
/// milliseconds — same epoch the rest of the store uses for
/// timestamp columns (audit, memory facts, tool invocations).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/types/")]
pub struct RecentPath {
    /// Absolute filesystem path. Stored verbatim (no normalisation),
    /// so the picker shows what the user actually typed.
    pub path: String,
    /// Unix milliseconds. Sorted DESC by the picker.
    pub last_used_at: i64,
}

/// Record that `path` was used at `now_ms`. Idempotent — calling
/// twice updates the timestamp on the existing row rather than
/// duplicating it. After insertion, evicts the least-recently-used
/// rows above [`MAX_ENTRIES`] so the buffer never grows unbounded.
///
/// Empty `path` is rejected with a `NOT NULL`-style error so the
/// caller doesn't pollute the picker with blank rows.
pub fn touch_recent_path(store: &Store, path: &str, now_ms: i64) -> Result<()> {
    if path.is_empty() {
        return Err(super::error::StoreError::Internal(
            "recent_paths.path may not be empty".to_string(),
        ));
    }
    let mut conn = store.conn()?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO recent_paths (path, last_used_at) \
         VALUES (?1, ?2) \
         ON CONFLICT(path) DO UPDATE SET last_used_at = excluded.last_used_at",
        params![path, now_ms],
    )?;
    // Trim if we're above the cap. `LIMIT -1 OFFSET N` is the
    // canonical SQLite idiom for "skip the first N rows" — we
    // keep the newest N, delete everything below.
    tx.execute(
        "DELETE FROM recent_paths \
         WHERE path IN ( \
             SELECT path FROM recent_paths \
             ORDER BY last_used_at DESC \
             LIMIT -1 OFFSET ?1 \
         )",
        params![MAX_ENTRIES as i64],
    )?;
    tx.commit()?;
    Ok(())
}

/// List the most-recently-used paths, capped at `limit`. Returns
/// rows ordered by `last_used_at` DESC so the picker can render
/// without re-sorting. `limit` is clamped to `[1, MAX_ENTRIES]`;
/// callers passing 0 or negative get the full buffer.
pub fn list_recent_paths(store: &Store, limit: i64) -> Result<Vec<RecentPath>> {
    let bounded = if limit <= 0 {
        MAX_ENTRIES as i64
    } else {
        limit.min(MAX_ENTRIES as i64)
    };
    let conn = store.conn()?;
    let mut stmt = conn.prepare(
        "SELECT path, last_used_at FROM recent_paths \
         ORDER BY last_used_at DESC \
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![bounded], |row| {
        Ok(RecentPath {
            path: row.get(0)?,
            last_used_at: row.get(1)?,
        })
    })?;
    let mut out = Vec::with_capacity(bounded as usize);
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Forget a specific path. Used when a user removes a project —
/// the picker shouldn't suggest a path that no longer exists. The
/// caller decides when to call this; the buffer itself doesn't
/// stat-check (that would be a sync I/O concern, and a missing
/// directory might just be a temporary unmount).
pub fn forget_recent_path(store: &Store, path: &str) -> Result<()> {
    let conn = store.conn()?;
    conn.execute("DELETE FROM recent_paths WHERE path = ?1", params![path])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Unit tests for the recent-paths CRUD. Each test opens a Store
    //! at a tempfile path (the canonical pattern in this crate — see
    //! `ai/budget.rs` and `cloud/keyring.rs`) and exercises the three
    //! public helpers. We never reach into the SQL directly — the
    //! assertions go through `list_recent_paths` so the column
    //! ordering invariant is exercised on every case.

    use super::*;
    use crate::store::Store;

    fn fresh_store() -> (Store, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = Store::open_at(&tmp.path().join("store.db")).expect("store");
        (store, tmp)
    }

    /// Newest-first iteration over the buffer.
    #[test]
    fn touch_records_path_and_list_returns_it() {
        let (store, _tmp) = fresh_store();
        touch_recent_path(&store, "D:\\web", 1_000).unwrap();
        let rows = list_recent_paths(&store, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "D:\\web");
        assert_eq!(rows[0].last_used_at, 1_000);
    }

    /// Touching an existing path updates its timestamp instead of
    /// inserting a duplicate row.
    #[test]
    fn touch_is_idempotent_on_path() {
        let (store, _tmp) = fresh_store();
        touch_recent_path(&store, "D:\\web", 1_000).unwrap();
        touch_recent_path(&store, "D:\\web", 2_000).unwrap();
        let rows = list_recent_paths(&store, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].last_used_at, 2_000);
    }

    /// list_recent_paths returns rows in last_used_at DESC order.
    #[test]
    fn list_orders_by_recency_desc() {
        let (store, _tmp) = fresh_store();
        touch_recent_path(&store, "a", 1_000).unwrap();
        touch_recent_path(&store, "b", 3_000).unwrap();
        touch_recent_path(&store, "c", 2_000).unwrap();
        let rows = list_recent_paths(&store, 10).unwrap();
        let paths: Vec<&str> = rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, vec!["b", "c", "a"]);
    }

    /// Eviction kicks in once the buffer exceeds MAX_ENTRIES.
    #[test]
    fn touch_evicts_oldest_above_cap() {
        let (store, _tmp) = fresh_store();
        // Insert MAX_ENTRIES + 5 distinct paths with increasing
        // timestamps. The oldest 5 should be evicted.
        for i in 0..(MAX_ENTRIES as i64 + 5) {
            touch_recent_path(&store, &format!("p{}", i), 1_000 + i).unwrap();
        }
        let rows = list_recent_paths(&store, MAX_ENTRIES as i64 + 10).unwrap();
        assert_eq!(rows.len(), MAX_ENTRIES);
        // Newest row is p{MAX+4}, oldest kept is p{5}.
        assert_eq!(rows.first().unwrap().path, format!("p{}", MAX_ENTRIES + 4));
        assert_eq!(rows.last().unwrap().path, format!("p{}", 5));
    }

    /// `limit` is honored, clamped to MAX_ENTRIES, and falls back
    /// to the full buffer on 0 or negative.
    #[test]
    fn list_limit_is_clamped() {
        let (store, _tmp) = fresh_store();
        for i in 0..10 {
            touch_recent_path(&store, &format!("p{}", i), 1_000 + i).unwrap();
        }
        assert_eq!(list_recent_paths(&store, 3).unwrap().len(), 3);
        assert_eq!(list_recent_paths(&store, 999).unwrap().len(), 10);
        assert_eq!(list_recent_paths(&store, 0).unwrap().len(), 10);
        assert_eq!(list_recent_paths(&store, -5).unwrap().len(), 10);
    }

    /// `forget_recent_path` drops the row; subsequent touches
    /// re-insert it with the new timestamp.
    #[test]
    fn forget_drops_then_touch_reinserts() {
        let (store, _tmp) = fresh_store();
        touch_recent_path(&store, "x", 1_000).unwrap();
        forget_recent_path(&store, "x").unwrap();
        assert!(list_recent_paths(&store, 10).unwrap().is_empty());
        touch_recent_path(&store, "x", 2_000).unwrap();
        let rows = list_recent_paths(&store, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].last_used_at, 2_000);
    }

    /// Empty path is rejected — keeps the picker free of blank rows.
    #[test]
    fn touch_rejects_empty_path() {
        let (store, _tmp) = fresh_store();
        let result = touch_recent_path(&store, "", 1_000);
        assert!(result.is_err());
    }

    /// Empty buffer returns an empty Vec, not an error.
    #[test]
    fn list_empty_buffer_returns_empty_vec() {
        let (store, _tmp) = fresh_store();
        let rows = list_recent_paths(&store, 10).unwrap();
        assert!(rows.is_empty());
    }
}
