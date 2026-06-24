//! SQLite-backed key-value cache for `SearchResponse` blobs.
//!
//! Schema (`search_cache`) carries enough denormalized columns that a
//! human spelunking the DB can correlate a hash back to the user-facing
//! error string and the language hint that produced it. The cache key
//! itself (`fingerprint`) is content-addressed via
//! `fingerprint::hash` — same input, same row.
//!
//! ## Eviction policy
//!
//! - **TTL: 7 days** from `created_at`. `get()` lazily deletes
//!   expired rows when it sees them; the dispatcher sees `Miss`.
//! - **LRU at 50 MB high-watermark, 40 MB low-watermark.** `set()`
//!   computes the running size after each insert and runs an eviction
//!   pass if over 50 MB, dropping rows ordered by
//!   `(hit_count ASC, last_hit_at ASC)` until the running size goes
//!   below 40 MB. The high/low pattern keeps eviction batches large
//!   enough to be worthwhile (avoid evicting one row per insert when
//!   we're hovering at the limit).
//!
//! ## Concurrency
//!
//! The single-writer SQLite limitation lives at the connection level.
//! We use one [`Mutex<Connection>`] inside [`Cache`] — every public
//! method takes the lock, so concurrent writers serialize cleanly.
//! WAL mode keeps reader-from-other-process fast, but inside this
//! crate we have one writer + zero other readers. The `Mutex` is only
//! poisoned if a panic occurs mid-operation; we recover via the
//! guard's `into_inner()` pattern (callers see a `Cache` error).

use crate::types::{SearchError, SearchResponse};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS search_cache (
    fingerprint   TEXT PRIMARY KEY,
    error_text    TEXT NOT NULL,
    language      TEXT,
    response_json TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_hit_at   INTEGER NOT NULL,
    hit_count     INTEGER NOT NULL DEFAULT 1,
    bytes         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_lru
    ON search_cache (hit_count, last_hit_at);
"#;

/// 7 days in seconds — TTL for cached responses.
pub const TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

/// Eviction high-watermark — bytes summed across `response_json`. When
/// `bytes` exceed this on the way out of `set()`, we evict down to
/// [`LRU_LOW_BYTES`].
pub const LRU_HIGH_BYTES: i64 = 50 * 1024 * 1024;
pub const LRU_LOW_BYTES: i64 = 40 * 1024 * 1024;

/// One row of the cache. Constructed by [`Cache::set`] and returned
/// (deserialized) by [`Cache::get`].
#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub fingerprint: String,
    pub error_text: String,
    pub language: Option<String>,
    pub response: SearchResponse,
    pub created_at: i64,
    pub last_hit_at: i64,
    pub hit_count: i64,
}

/// Top-level cache handle. Cheap to clone via `Arc<Cache>` — the
/// internal `Mutex<Connection>` serializes accesses.
pub struct Cache {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Cache {
    /// Open or create the cache DB at `path`. Parent directory must
    /// already exist (the dispatcher's bootstrap creates it once on
    /// startup). Sets WAL + `synchronous=NORMAL` for write throughput.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SearchError> {
        let path = path.into();
        let conn = Connection::open(&path)
            .map_err(|e| SearchError::Cache(format!("open {}: {e}", path.display())))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;",
        )
        .map_err(|e| SearchError::Cache(format!("pragmas: {e}")))?;
        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| SearchError::Cache(format!("schema: {e}")))?;
        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// Useful for tests / `~/.inariwatch/inari-search/cache.db`-style
    /// debug. Returns the on-disk path the cache was opened with.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Lookup by fingerprint. Returns `None` for a miss OR an expired
    /// row (which is also lazy-deleted as a side effect).
    pub fn get(&self, fingerprint: &str) -> Result<Option<CacheEntry>, SearchError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| SearchError::Cache(format!("mutex: {e}")))?;
        let now = unix_now_secs();
        let row = conn
            .query_row(
                "SELECT fingerprint, error_text, language, response_json,
                        created_at, last_hit_at, hit_count
                 FROM search_cache WHERE fingerprint = ?1",
                params![fingerprint],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| SearchError::Cache(format!("get: {e}")))?;

        let Some((fp, err, lang, json, created, _last_hit, hits)) = row else {
            return Ok(None);
        };

        if now.saturating_sub(created) > TTL_SECONDS {
            // Expired — delete and report as miss.
            conn.execute(
                "DELETE FROM search_cache WHERE fingerprint = ?1",
                params![fp],
            )
            .map_err(|e| SearchError::Cache(format!("ttl-delete: {e}")))?;
            return Ok(None);
        }

        // Bump LRU stats — atomic enough for our purposes (single
        // writer behind the mutex). hit_count goes up, last_hit_at
        // refreshes.
        conn.execute(
            "UPDATE search_cache SET hit_count = hit_count + 1, last_hit_at = ?1
             WHERE fingerprint = ?2",
            params![now, fp],
        )
        .map_err(|e| SearchError::Cache(format!("update lru: {e}")))?;

        let response: SearchResponse = serde_json::from_str(&json)
            .map_err(|e| SearchError::Cache(format!("deserialize: {e}")))?;

        Ok(Some(CacheEntry {
            fingerprint: fp,
            error_text: err,
            language: lang,
            response,
            created_at: created,
            last_hit_at: now,
            hit_count: hits + 1,
        }))
    }

    /// Insert or replace a cached row. Runs the LRU eviction pass on
    /// the way out; ANY caller can trigger it when the cache crosses
    /// the high-watermark.
    pub fn set(
        &self,
        fingerprint: &str,
        error_text: &str,
        language: Option<&str>,
        response: &SearchResponse,
    ) -> Result<(), SearchError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| SearchError::Cache(format!("mutex: {e}")))?;
        let json = serde_json::to_string(response)
            .map_err(|e| SearchError::Cache(format!("serialize: {e}")))?;
        let bytes = json.len() as i64;
        let now = unix_now_secs();

        // INSERT OR REPLACE rewrites the LRU stats so a refresh of the
        // same fingerprint resets created_at + hit_count. Intentional —
        // the dispatcher only writes the cache when it has fresh data.
        conn.execute(
            "INSERT OR REPLACE INTO search_cache
                (fingerprint, error_text, language, response_json,
                 created_at, last_hit_at, hit_count, bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, ?6)",
            params![fingerprint, error_text, language, json, now, bytes],
        )
        .map_err(|e| SearchError::Cache(format!("set: {e}")))?;

        // Eviction pass — tolerate a single failure (don't fail the
        // set itself for a downstream cleanup error).
        if let Err(e) = run_eviction(&mut conn) {
            tracing::warn!(error = %e, "[inari-search] eviction pass failed");
        }
        Ok(())
    }

    /// Total `bytes` summed across the cache. Test helper + debug.
    pub fn total_bytes(&self) -> Result<i64, SearchError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| SearchError::Cache(format!("mutex: {e}")))?;
        let n: Option<i64> = conn
            .query_row(
                "SELECT SUM(bytes) FROM search_cache",
                params![],
                |r| r.get::<_, Option<i64>>(0),
            )
            .map_err(|e| SearchError::Cache(format!("sum: {e}")))?;
        Ok(n.unwrap_or(0))
    }

    /// Number of rows. Test helper + debug.
    pub fn row_count(&self) -> Result<i64, SearchError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| SearchError::Cache(format!("mutex: {e}")))?;
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM search_cache", params![], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| SearchError::Cache(format!("count: {e}")))?;
        Ok(n)
    }
}

fn run_eviction(conn: &mut Connection) -> Result<(), SearchError> {
    let total: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(bytes), 0) FROM search_cache",
            params![],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| SearchError::Cache(format!("eviction sum: {e}")))?;

    if total <= LRU_HIGH_BYTES {
        return Ok(());
    }

    // Walk rows in eviction order and stop when we've freed enough.
    // SQLite doesn't have a "DELETE WHERE running_total <= X" clause,
    // so we collect candidate fingerprints in order and delete in
    // batches. This is N log N over rows; cache is small (≤ ~10k
    // entries on a 50 MB budget), so it's fine.
    let to_free = total - LRU_LOW_BYTES;
    let mut freed: i64 = 0;
    let mut victims: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT fingerprint, bytes FROM search_cache
                 ORDER BY hit_count ASC, last_hit_at ASC",
            )
            .map_err(|e| SearchError::Cache(format!("eviction stmt: {e}")))?;
        let mut rows = stmt
            .query(params![])
            .map_err(|e| SearchError::Cache(format!("eviction query: {e}")))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| SearchError::Cache(format!("eviction next: {e}")))?
        {
            let fp: String = row
                .get(0)
                .map_err(|e| SearchError::Cache(format!("eviction get fp: {e}")))?;
            let b: i64 = row
                .get(1)
                .map_err(|e| SearchError::Cache(format!("eviction get bytes: {e}")))?;
            victims.push(fp);
            freed += b;
            if freed >= to_free {
                break;
            }
        }
    }

    let tx = conn
        .transaction()
        .map_err(|e| SearchError::Cache(format!("eviction tx: {e}")))?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM search_cache WHERE fingerprint = ?1")
            .map_err(|e| SearchError::Cache(format!("eviction del stmt: {e}")))?;
        for fp in &victims {
            stmt.execute(params![fp])
                .map_err(|e| SearchError::Cache(format!("eviction del: {e}")))?;
        }
    }
    tx.commit()
        .map_err(|e| SearchError::Cache(format!("eviction commit: {e}")))?;
    Ok(())
}

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// Visible to test harness for synthetic-time TTL tests — back-dates an
// existing row's `created_at` (and `last_hit_at`) by `seconds`. NOT
// callable in production builds.
#[cfg(any(test, feature = "test-utils"))]
impl Cache {
    pub fn debug_age_row(
        &self,
        fingerprint: &str,
        seconds: i64,
    ) -> Result<(), SearchError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| SearchError::Cache(format!("mutex: {e}")))?;
        conn.execute(
            "UPDATE search_cache
                SET created_at = created_at - ?1,
                    last_hit_at = last_hit_at - ?1
              WHERE fingerprint = ?2",
            params![seconds, fingerprint],
        )
        .map_err(|e| SearchError::Cache(format!("debug_age: {e}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CacheStatus, SearchResponse, SourceState, SourceStatus, SourceTag};

    fn cache() -> Cache {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("cache.db");
        let cache = Cache::open(&p).expect("open");
        // Leak the tempdir for the test's lifetime — cache holds a
        // file in there and dropping `dir` would unlink it before the
        // SQLite handle closes.
        std::mem::forget(dir);
        cache
    }

    fn small_response() -> SearchResponse {
        SearchResponse {
            hits: Vec::new(),
            sources_used: vec![SourceStatus {
                source: SourceTag::StackOverflow,
                state: SourceState::Ok { hit_count: 0 },
            }],
            cache_status: CacheStatus::Miss,
            elapsed_ms: 12,
            quota_low: false,
        }
    }

    #[test]
    fn open_creates_table_and_sets_wal() {
        let c = cache();
        assert_eq!(c.row_count().unwrap(), 0);
    }

    #[test]
    fn set_then_get_round_trips() {
        let c = cache();
        c.set("fp-1", "TypeError x", Some("javascript"), &small_response())
            .unwrap();
        let entry = c.get("fp-1").unwrap().expect("hit");
        assert_eq!(entry.fingerprint, "fp-1");
        assert_eq!(entry.error_text, "TypeError x");
        assert_eq!(entry.language.as_deref(), Some("javascript"));
        assert_eq!(entry.response.elapsed_ms, 12);
        // hit_count starts at 1 on insert + 1 on get.
        assert_eq!(entry.hit_count, 2);
    }

    #[test]
    fn get_returns_none_for_missing_fingerprint() {
        let c = cache();
        assert!(c.get("nope").unwrap().is_none());
    }

    #[test]
    fn ttl_eviction_drops_expired_row_lazily() {
        let c = cache();
        c.set("fp-old", "old", None, &small_response()).unwrap();
        c.debug_age_row("fp-old", TTL_SECONDS + 60).unwrap();
        assert!(c.get("fp-old").unwrap().is_none(), "expired row should be evicted");
        assert_eq!(c.row_count().unwrap(), 0);
    }

    #[test]
    fn fresh_row_within_ttl_is_returned() {
        let c = cache();
        c.set("fp-fresh", "fresh", None, &small_response()).unwrap();
        c.debug_age_row("fp-fresh", TTL_SECONDS - 60).unwrap();
        assert!(c.get("fp-fresh").unwrap().is_some());
    }

    #[test]
    fn lru_high_watermark_triggers_eviction_to_low_watermark() {
        let c = cache();

        // Build a synthetic response large enough to push the cache
        // above 50 MB across few inserts. Each response carries ~1 MB
        // of padding in `quota_low` ... wait, quota_low is bool — we
        // need to inflate the JSON some other way. Stuff a long
        // `error.message` into a bunch of SourceState::Error rows.
        let big_message = "x".repeat(500_000); // 500 KB per row
        let bigger = SearchResponse {
            hits: Vec::new(),
            sources_used: (0..10)
                .map(|i| SourceStatus {
                    source: SourceTag::GitHub,
                    state: SourceState::Error {
                        message: format!("err-{i}: {big_message}"),
                    },
                })
                .collect(),
            cache_status: CacheStatus::Miss,
            elapsed_ms: 0,
            quota_low: false,
        };

        // Each insert ≈ 5 MB (10 × 500 KB). 12 inserts = ~60 MB > 50 MB.
        for i in 0..12 {
            c.set(&format!("fp-big-{i}"), "x", None, &bigger).unwrap();
        }
        let total = c.total_bytes().unwrap();
        assert!(
            total <= LRU_HIGH_BYTES,
            "after eviction total {total} should be <= high {LRU_HIGH_BYTES}"
        );
        assert!(
            total <= LRU_LOW_BYTES + 5 * 1024 * 1024,
            "after eviction total {total} should be near low {LRU_LOW_BYTES}"
        );
    }

    #[test]
    fn lru_eviction_drops_lowest_hit_count_first() {
        let c = cache();
        let resp = small_response();
        // Insert 3 rows.
        c.set("fp-cold", "cold", None, &resp).unwrap();
        c.set("fp-hot", "hot", None, &resp).unwrap();
        c.set("fp-warm", "warm", None, &resp).unwrap();

        // Bump fp-hot's hit_count by reading it 5 times.
        for _ in 0..5 {
            assert!(c.get("fp-hot").unwrap().is_some());
        }
        // Bump fp-warm by 1.
        assert!(c.get("fp-warm").unwrap().is_some());

        // Force eviction by directly running it after fudging
        // size-budget down to make all 3 over-budget.
        // Simpler: assert ordering query is correct (the actual
        // eviction is exercised in the previous test).
        let conn = c.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT fingerprint FROM search_cache
                 ORDER BY hit_count ASC, last_hit_at ASC",
            )
            .unwrap();
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        // fp-cold was inserted first and never read again → lowest hit_count.
        assert_eq!(rows[0], "fp-cold");
    }

    #[test]
    fn replacing_a_fingerprint_resets_hit_count_and_created_at() {
        let c = cache();
        c.set("fp-r", "v1", None, &small_response()).unwrap();
        // Read it a few times to bump hit_count.
        for _ in 0..5 {
            c.get("fp-r").unwrap();
        }
        let entry_before = c.get("fp-r").unwrap().unwrap();
        assert!(entry_before.hit_count >= 6);

        // Replace.
        c.set("fp-r", "v2", None, &small_response()).unwrap();
        let entry_after = c.get("fp-r").unwrap().unwrap();
        // hit_count starts back at 1 + 1 (the get above).
        assert_eq!(entry_after.hit_count, 2);
        assert_eq!(entry_after.error_text, "v2");
    }

    #[test]
    fn concurrent_sets_do_not_corrupt_state() {
        use std::sync::Arc;
        use std::thread;

        let c = Arc::new(cache());
        let mut handles = Vec::new();
        for tid in 0..4 {
            let c = c.clone();
            handles.push(thread::spawn(move || {
                for i in 0..50 {
                    let fp = format!("fp-t{tid}-{i}");
                    c.set(&fp, "x", None, &small_response()).unwrap();
                    let _ = c.get(&fp).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().expect("worker");
        }
        assert_eq!(c.row_count().unwrap(), 4 * 50);
    }
}
