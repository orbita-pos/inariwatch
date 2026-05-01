//! Typed query helpers used by the rest of the daemon.
//!
//! Sessions that touch the store (5 — repos / 11–13 — memory layers /
//! 19 — remediation history) extend this module. Keep raw SQL
//! contained here so consumers stay schema-agnostic.

use rusqlite::{params, OptionalExtension};

use super::error::Result;
use super::Store;

/// Resolve a repo id by canonical filesystem path. Returns `None` if
/// the repo has not been opened. The caller decides whether absence
/// means "register first" or "error out".
pub fn find_repo_by_path(store: &Store, path: &str) -> Result<Option<String>> {
    let conn = store.conn()?;
    let id = conn
        .query_row(
            "SELECT id FROM repos WHERE path = ?1",
            params![path],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(id)
}

/// Idempotent insert of a repo row. Returns the existing id when the
/// path is already known so callers don't have to branch.
pub fn upsert_repo(
    store: &Store,
    id: &str,
    path: &str,
    name: &str,
    opened_at_ms: i64,
) -> Result<String> {
    if let Some(existing) = find_repo_by_path(store, path)? {
        return Ok(existing);
    }

    let conn = store.conn()?;
    conn.execute(
        "INSERT INTO repos (id, path, name, opened_at, indexed_file_count)
         VALUES (?1, ?2, ?3, ?4, 0)",
        params![id, path, name, opened_at_ms],
    )?;
    Ok(id.to_string())
}

/// Append a generic event row. `payload` is opaque JSON; the schema
/// is defined by the consumer in `kind`. Returns the autoincrement
/// rowid for downstream correlation.
pub fn insert_event(
    store: &Store,
    timestamp_ms: i64,
    kind: &str,
    repo_id: Option<&str>,
    payload_json: &str,
) -> Result<i64> {
    let conn = store.conn()?;
    conn.execute(
        "INSERT INTO events (timestamp, kind, repo_id, payload)
         VALUES (?1, ?2, ?3, ?4)",
        params![timestamp_ms, kind, repo_id, payload_json],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Filter for [`query_events`] (Sesión 13 — episodic memory). All
/// fields are optional intersections; `None` means "any". When all are
/// `None` you get the most-recent rows up to `limit`.
#[derive(Debug, Clone, Default)]
pub struct EventFilter<'a> {
    pub kind:    Option<&'a str>,
    pub repo_id: Option<&'a str>,
    /// Lower bound on `timestamp` (inclusive). Use `None` for "no floor".
    pub since:   Option<i64>,
    /// Upper bound on the row count. Defaults to 100 when `None` to
    /// keep the query bounded — callers that need everything pass a
    /// concrete large number.
    pub limit:   Option<usize>,
}

/// One event row read back from the `events` table. The payload is
/// returned raw — consumers that care about a specific shape parse it
/// themselves (we deliberately avoid coupling the store to per-kind
/// schemas; the kind taxonomy lives in `crate::daemon::DaemonEvent`).
#[derive(Debug, Clone)]
pub struct EventRow {
    pub id:           i64,
    pub timestamp_ms: i64,
    pub kind:         String,
    pub repo_id:      Option<String>,
    pub payload_json: String,
}

/// Read events with the given filter. Sorted by `timestamp DESC` so the
/// most recent rows come first — matches what callers in the AI layer
/// (Sesión 19 remediation context) want by default.
pub fn query_events(store: &Store, filter: &EventFilter<'_>) -> Result<Vec<EventRow>> {
    let conn = store.conn()?;

    // Build WHERE fragments + bind values together so the positional
    // parameter index always matches the bind order. Every fragment is
    // a static string template; only the values flow through `params`.
    let mut where_parts: Vec<String>            = Vec::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut idx = 1usize;
    if let Some(k) = filter.kind {
        where_parts.push(format!("kind = ?{idx}"));
        binds.push(Box::new(k.to_string()));
        idx += 1;
    }
    if let Some(r) = filter.repo_id {
        where_parts.push(format!("repo_id = ?{idx}"));
        binds.push(Box::new(r.to_string()));
        idx += 1;
    }
    if let Some(s) = filter.since {
        where_parts.push(format!("timestamp >= ?{idx}"));
        binds.push(Box::new(s));
        idx += 1;
    }
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_parts.join(" AND "))
    };

    let limit = filter.limit.unwrap_or(100).min(10_000);
    let sql = format!(
        "SELECT id, timestamp, kind, repo_id, payload
         FROM events{}
         ORDER BY timestamp DESC
         LIMIT ?{}",
        where_sql, idx,
    );
    binds.push(Box::new(limit as i64));

    let mut stmt = conn.prepare(&sql)?;
    let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(bind_refs.into_iter()), |r| {
        Ok(EventRow {
            id:           r.get(0)?,
            timestamp_ms: r.get(1)?,
            kind:         r.get(2)?,
            repo_id:      r.get(3)?,
            payload_json: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows { out.push(row?); }
    Ok(out)
}

/// Drop every event row for `kind` whose `timestamp` is strictly
/// older than `cutoff_ts_ms`. Returns the number of rows actually
/// deleted so the retention runner can decide whether to VACUUM.
pub fn delete_events_older_than(
    store:        &Store,
    kind:         &str,
    cutoff_ts_ms: i64,
) -> Result<usize> {
    let conn = store.conn()?;
    let n = conn.execute(
        "DELETE FROM events WHERE kind = ?1 AND timestamp < ?2",
        params![kind, cutoff_ts_ms],
    )?;
    Ok(n)
}

/// Per-kind row counts in the `events` table. Used by the retention
/// runner for telemetry + by integration tests to assert the deletion
/// behaviour without touching SQL directly.
pub fn count_events_by_kind(store: &Store) -> Result<std::collections::HashMap<String, u64>> {
    let conn = store.conn()?;
    let mut stmt = conn.prepare(
        "SELECT kind, COUNT(*) FROM events GROUP BY kind",
    )?;
    let rows = stmt.query_map([], |r| {
        let kind:  String = r.get(0)?;
        let count: i64    = r.get(1)?;
        Ok((kind, count.max(0) as u64))
    })?;
    let mut out = std::collections::HashMap::new();
    for r in rows {
        let (k, c) = r?;
        out.insert(k, c);
    }
    Ok(out)
}

/// `VACUUM` the underlying database. SQLite serializes the operation —
/// the pool's other connections wait. Used by the retention runner
/// when a tick deletes a meaningful number of rows so the file shrinks
/// instead of just leaving free pages.
pub fn vacuum(store: &Store) -> Result<()> {
    let conn = store.conn()?;
    conn.execute_batch("VACUUM")?;
    Ok(())
}

/// Read the per-repo `replay_enabled` flag (migration 0004). Returns
/// `false` for unknown ids — the substrate sensor (Session 10) treats
/// "no row" identically to "row says off" so `FsChange` events for
/// repos that haven't been opened in the dock are ignored without an
/// error path.
pub fn find_repo_replay_enabled(store: &Store, id: &str) -> Result<bool> {
    let conn = store.conn()?;
    let enabled: Option<bool> = conn
        .query_row(
            "SELECT replay_enabled FROM repos WHERE id = ?1",
            params![id],
            |row| row.get::<_, bool>(0),
        )
        .optional()?;
    Ok(enabled.unwrap_or(false))
}

/// Toggle the per-repo `replay_enabled` flag (migration 0004). Public
/// for the dock IPC surface (Session 17) and integration tests; the
/// substrate sensor itself only reads the flag, never writes it.
pub fn set_repo_replay_enabled(store: &Store, id: &str, enabled: bool) -> Result<()> {
    let conn = store.conn()?;
    conn.execute(
        "UPDATE repos SET replay_enabled = ?2 WHERE id = ?1",
        params![id, enabled],
    )?;
    Ok(())
}

/// Lookup the canonical filesystem path of an opened repo. Returns
/// `None` when the id has not been registered. Used by the indexer
/// (Session 6) when it sees `RepoIndexed` / `ReindexRequested` and
/// needs to walk the repo from disk.
pub fn find_repo_path_by_id(store: &Store, id: &str) -> Result<Option<String>> {
    let conn = store.conn()?;
    let path = conn
        .query_row(
            "SELECT path FROM repos WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(path)
}

// ── Code symbols + embeddings (Session 6 — indexer) ──────────────────────────
//
// `code_symbols` (UNIQUE on `repo_id, file_path, symbol_name, line_start`)
// and the `code_embeddings` virtual table (vec0, FLOAT[384]) are defined
// in migration `0002_embeddings.sql`. The helpers below stay raw-SQL so
// the indexer never reaches into rusqlite directly. All values that
// reach SQL flow through `params!` — no string concat.

/// Symbol metadata persisted to `code_symbols`. The indexer hands this
/// in; the helper returns the rowid so the caller can correlate it
/// with the embedding insert.
#[derive(Debug, Clone)]
pub struct SymbolRow<'a> {
    pub repo_id:     &'a str,
    pub file_path:   &'a str,
    pub symbol_name: &'a str,
    pub kind:        &'a str,
    pub line_start:  u32,
    pub line_end:    u32,
    pub ast_hash:    &'a str,
}

/// Existing symbol row shape used by the indexer to detect "did the
/// AST hash change since last index?". `id` is the rowid; `ast_hash`
/// is the sha256 of the canonicalized source text.
#[derive(Debug, Clone)]
pub struct ExistingSymbol {
    pub id:       i64,
    pub ast_hash: String,
}

/// Search hit returned by `semantic_search`. Cosine similarity is
/// `1 - vec_distance_cosine`; sqlite-vec returns the distance, the
/// helper inverts it so consumers can sort descending and treat
/// "higher = better" uniformly.
#[derive(Debug, Clone)]
pub struct SymbolHit {
    pub repo_id:     String,
    pub file_path:   String,
    pub symbol_name: String,
    pub kind:        String,
    pub line_start:  u32,
    pub line_end:    u32,
    pub similarity:  f32,
}

/// Upsert a symbol. Insert on first sight, refresh `ast_hash` /
/// `line_end` / `kind` when the (repo_id, file_path, symbol_name,
/// line_start) tuple already exists (the UNIQUE constraint from
/// migration 0002). Returns the rowid for embedding insertion.
pub fn upsert_symbol(store: &Store, sym: &SymbolRow<'_>) -> Result<i64> {
    let conn = store.conn()?;
    conn.execute(
        "INSERT INTO code_symbols
            (repo_id, file_path, symbol_name, kind, line_start, line_end, ast_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(repo_id, file_path, symbol_name, line_start) DO UPDATE SET
            kind     = excluded.kind,
            line_end = excluded.line_end,
            ast_hash = excluded.ast_hash",
        params![
            sym.repo_id,
            sym.file_path,
            sym.symbol_name,
            sym.kind,
            sym.line_start,
            sym.line_end,
            sym.ast_hash,
        ],
    )?;

    // ON CONFLICT DO UPDATE doesn't change last_insert_rowid in
    // rusqlite when the conflict path runs; look the row up explicitly
    // to be deterministic across insert vs. update.
    let id: i64 = conn.query_row(
        "SELECT id FROM code_symbols
         WHERE repo_id = ?1 AND file_path = ?2 AND symbol_name = ?3 AND line_start = ?4",
        params![sym.repo_id, sym.file_path, sym.symbol_name, sym.line_start],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// Read the existing rowid + ast_hash for a (repo_id, file_path,
/// symbol_name, line_start) tuple. Used by the indexer to skip
/// re-embedding when the AST hash is unchanged.
pub fn find_symbol_hash(
    store: &Store,
    repo_id: &str,
    file_path: &str,
    symbol_name: &str,
    line_start: u32,
) -> Result<Option<ExistingSymbol>> {
    let conn = store.conn()?;
    let row = conn
        .query_row(
            "SELECT id, ast_hash FROM code_symbols
             WHERE repo_id = ?1 AND file_path = ?2 AND symbol_name = ?3 AND line_start = ?4",
            params![repo_id, file_path, symbol_name, line_start],
            |r| Ok(ExistingSymbol {
                id:       r.get(0)?,
                ast_hash: r.get(1)?,
            }),
        )
        .optional()?;
    Ok(row)
}

/// Upsert a 384-dim embedding for a `code_symbols.id`. Two-step
/// (DELETE then INSERT) because sqlite-vec's vec0 module does not
/// support `ON CONFLICT` upsert today.
pub fn upsert_embedding(store: &Store, symbol_id: i64, embedding: &[f32]) -> Result<()> {
    if embedding.len() != 384 {
        return Err(super::error::StoreError::Internal(format!(
            "embedding dim mismatch: got {}, expected 384",
            embedding.len()
        )));
    }
    let bytes = embedding_to_bytes(embedding);
    let conn  = store.conn()?;
    conn.execute(
        "DELETE FROM code_embeddings WHERE symbol_id = ?1",
        params![symbol_id],
    )?;
    conn.execute(
        "INSERT INTO code_embeddings (symbol_id, embedding) VALUES (?1, ?2)",
        params![symbol_id, bytes],
    )?;
    Ok(())
}

/// Delete every symbol row (and via vec0's foreign-key cascade, the
/// embedding) for `(repo_id, file_path)`. Used by the indexer when a
/// file is deleted on disk.
pub fn delete_symbols_for_file(
    store: &Store,
    repo_id: &str,
    file_path: &str,
) -> Result<u64> {
    let conn = store.conn()?;
    // Manually drop embeddings first — vec0 is a virtual table and
    // does NOT participate in FK cascades. Two passes keep the DB
    // consistent even on a crash between them (orphan embeddings
    // would simply be unreachable, never wrong).
    conn.execute(
        "DELETE FROM code_embeddings
         WHERE symbol_id IN (
             SELECT id FROM code_symbols
             WHERE repo_id = ?1 AND file_path = ?2
         )",
        params![repo_id, file_path],
    )?;
    let rows = conn.execute(
        "DELETE FROM code_symbols WHERE repo_id = ?1 AND file_path = ?2",
        params![repo_id, file_path],
    )?;
    Ok(rows as u64)
}

/// Rename every symbol row for `(repo_id, from)` to `(repo_id, to)`.
/// Used by the indexer when an `FsChange::Renamed { from }` arrives
/// AND the AST hash hasn't changed (i.e. the file content survived
/// the rename — most editor "save as" flows look like this).
pub fn rename_file_path(
    store: &Store,
    repo_id: &str,
    from: &str,
    to: &str,
) -> Result<u64> {
    let conn = store.conn()?;
    let rows = conn.execute(
        "UPDATE code_symbols SET file_path = ?3
         WHERE repo_id = ?1 AND file_path = ?2",
        params![repo_id, from, to],
    )?;
    Ok(rows as u64)
}

/// Total `code_symbols` rows for a repo. Used in the
/// `SymbolsIndexed` event payload.
pub fn count_symbols_for_repo(store: &Store, repo_id: &str) -> Result<u64> {
    let conn = store.conn()?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM code_symbols WHERE repo_id = ?1",
        params![repo_id],
        |row| row.get(0),
    )?;
    Ok(n.max(0) as u64)
}

/// Run a vec0-backed semantic search: nearest-neighbour over
/// `code_embeddings`, joined back to `code_symbols` for metadata.
/// `repo_id` filters the join (None searches all repos). `k` is the
/// LIMIT — caller is responsible for capping at a sane value (the
/// indexer caps at 50). Returns at most `k` rows, sorted by
/// similarity descending (closest match first).
pub fn semantic_search(
    store: &Store,
    query_embedding: &[f32],
    k: usize,
    repo_id: Option<&str>,
) -> Result<Vec<SymbolHit>> {
    if query_embedding.len() != 384 {
        return Err(super::error::StoreError::Internal(format!(
            "query embedding dim mismatch: got {}, expected 384",
            query_embedding.len()
        )));
    }
    let bytes = embedding_to_bytes(query_embedding);
    let conn  = store.conn()?;

    // sqlite-vec's KNN syntax: `embedding MATCH ? AND k = ?`. The
    // returned `distance` is cosine distance ∈ [0, 2]; similarity is
    // `1 - distance` ∈ [-1, 1]. Filtering by repo_id happens after
    // the KNN ranking — vec0 doesn't pushdown predicates today.
    let sql = if repo_id.is_some() {
        "SELECT s.repo_id, s.file_path, s.symbol_name, s.kind,
                s.line_start, s.line_end, e.distance
         FROM code_embeddings e
         JOIN code_symbols  s ON s.id = e.symbol_id
         WHERE e.embedding MATCH ?1 AND k = ?2 AND s.repo_id = ?3
         ORDER BY e.distance ASC
         LIMIT ?2"
    } else {
        "SELECT s.repo_id, s.file_path, s.symbol_name, s.kind,
                s.line_start, s.line_end, e.distance
         FROM code_embeddings e
         JOIN code_symbols  s ON s.id = e.symbol_id
         WHERE e.embedding MATCH ?1 AND k = ?2
         ORDER BY e.distance ASC
         LIMIT ?2"
    };

    let mut stmt = conn.prepare(sql)?;
    // Over-fetch a bit when repo_id is set so the post-filter has
    // headroom — vec0's KNN doesn't pushdown predicates, so
    // narrowing happens after ranking.
    let knn_k: i64 = if repo_id.is_some() {
        ((k as i64) * 4).max(k as i64)
    } else {
        k as i64
    };

    let mut hits: Vec<SymbolHit> = Vec::with_capacity(k);

    let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<SymbolHit> {
        let distance: f64 = r.get(6)?;
        Ok(SymbolHit {
            repo_id:     r.get(0)?,
            file_path:   r.get(1)?,
            symbol_name: r.get(2)?,
            kind:        r.get(3)?,
            line_start:  r.get::<_, i64>(4)? as u32,
            line_end:    r.get::<_, i64>(5)? as u32,
            similarity:  (1.0_f64 - distance).max(-1.0).min(1.0) as f32,
        })
    };

    if let Some(rid) = repo_id {
        let rows = stmt.query_map(params![bytes, knn_k, rid], map_row)?;
        for row in rows {
            hits.push(row?);
            if hits.len() >= k {
                break;
            }
        }
    } else {
        let rows = stmt.query_map(params![bytes, knn_k], map_row)?;
        for row in rows {
            hits.push(row?);
            if hits.len() >= k {
                break;
            }
        }
    }

    Ok(hits)
}

/// Encode an `&[f32]` as the little-endian byte payload sqlite-vec
/// accepts as a BLOB. Length is always `4 * embedding.len()`.
fn embedding_to_bytes(embedding: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(embedding.len() * 4);
    for f in embedding {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

// ── memory.md versions (Session 11 — declarative memory) ─────────────────────
//
// `memory_md_versions` (defined in migration 0003) is append-only. The
// declarative watcher writes a new row every time `memory.md` is created
// or merged, so the dock's "history" view can offer audit / rollback
// without depending on git. Schema:
//   id          INTEGER PRIMARY KEY AUTOINCREMENT
//   repo_id     TEXT    NOT NULL  → repos(id) ON DELETE CASCADE
//   content     TEXT    NOT NULL
//   written_by  TEXT    NOT NULL  ('ai' | 'merge' | 'human')
//   written_at  INTEGER NOT NULL  (unix epoch milliseconds)

/// One row from `memory_md_versions`. Returned by the `latest_*` query
/// so callers can render full provenance (who wrote it, when) instead
/// of just the bytes.
#[derive(Debug, Clone)]
pub struct MemoryMdVersion {
    pub id:         i64,
    pub repo_id:    String,
    pub content:    String,
    pub written_by: String,
    pub written_at: i64,
}

/// Append a new `memory.md` version. Returns the autoincrement rowid so
/// the caller can correlate with downstream events. `written_by` is a
/// short label — currently `"ai"` for the initial template, `"merge"`
/// for an approved review, `"human"` for direct user edits captured
/// from the file watcher.
pub fn insert_memory_md_version(
    store: &Store,
    repo_id: &str,
    content: &str,
    written_by: &str,
    written_at_ms: i64,
) -> Result<i64> {
    let conn = store.conn()?;
    conn.execute(
        "INSERT INTO memory_md_versions (repo_id, content, written_by, written_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![repo_id, content, written_by, written_at_ms],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Read the latest version row for a repo. Returns `None` when nothing
/// has been written yet (fresh repo or post-wipe). The index
/// `memory_md_repo_ts_idx (repo_id, written_at DESC)` makes this a
/// 1-row lookup.
pub fn latest_memory_md_version(
    store: &Store,
    repo_id: &str,
) -> Result<Option<MemoryMdVersion>> {
    let conn = store.conn()?;
    let row = conn
        .query_row(
            "SELECT id, repo_id, content, written_by, written_at
             FROM memory_md_versions
             WHERE repo_id = ?1
             ORDER BY written_at DESC
             LIMIT 1",
            params![repo_id],
            |r| {
                Ok(MemoryMdVersion {
                    id:         r.get(0)?,
                    repo_id:    r.get(1)?,
                    content:    r.get(2)?,
                    written_by: r.get(3)?,
                    written_at: r.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Delete every `memory_md_versions` row for a repo. Used by the
/// "Wipe memory" affordance (Session 11 / dock spec § Wipe). Returns
/// the row count actually removed so the IPC surface can echo it back
/// for audit.
///
/// Note: the spec calls out that wiping the local `index.db` does NOT
/// touch the on-disk `memory.md` (preserves human work). This helper
/// matches that contract — it only wipes the SQL audit trail, not the
/// markdown file. The caller is responsible for `memory.md` deletion
/// (or preservation) policy.
pub fn wipe_memory_md_versions(store: &Store, repo_id: &str) -> Result<usize> {
    let conn = store.conn()?;
    let rows = conn.execute(
        "DELETE FROM memory_md_versions WHERE repo_id = ?1",
        params![repo_id],
    )?;
    Ok(rows)
}

// ── Wipe-repo-index (Session 17 — Settings → Repos → "Wipe memory") ──────────
//
// Used by the dock Settings surface (Sesión 17). The naming "Wipe memory"
// in the UI refers to the SQL index — the on-disk `memory.md` is
// intentionally preserved (human work, see Sesión 11 decision). This
// helper is the single entry point: code symbols + embeddings + events
// + patterns are dropped for the repo; `memory_md_versions` is NOT.

/// Counts of rows actually removed by [`wipe_repo_index`]. Returned to
/// the IPC surface so the dock can show a confirmation toast like
/// "Cleared 12 384 symbols + 837 events".
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct WipeRepoIndexCounts {
    pub symbols:    usize,
    pub embeddings: usize,
    pub events:     usize,
    pub patterns:   usize,
}

/// Drop every cache-shaped row tied to `repo_id`. Preserves the
/// `memory_md_versions` history (human-authored memory) and the `repos`
/// row itself (so the user keeps the repo registered). Per Sesión 17
/// spec + Sesión 11 decision: never delete the on-disk `memory.md`.
pub fn wipe_repo_index(store: &Store, repo_id: &str) -> Result<WipeRepoIndexCounts> {
    let mut counts = WipeRepoIndexCounts::default();

    let conn = store.conn()?;
    // Embeddings first — vec0 is virtual and doesn't follow the FK
    // cascade. Drop the BLOBs before the symbol rows so a crash between
    // the two passes leaves orphan embeddings (unreachable) instead of
    // dangling FKs (wrong).
    counts.embeddings = conn.execute(
        "DELETE FROM code_embeddings
         WHERE symbol_id IN (SELECT id FROM code_symbols WHERE repo_id = ?1)",
        params![repo_id],
    )?;
    counts.symbols = conn.execute(
        "DELETE FROM code_symbols WHERE repo_id = ?1",
        params![repo_id],
    )?;
    counts.events = conn.execute(
        "DELETE FROM events WHERE repo_id = ?1",
        params![repo_id],
    )?;
    counts.patterns = conn.execute(
        "DELETE FROM patterns WHERE repo_id = ?1",
        params![repo_id],
    )?;

    Ok(counts)
}

/// Slim repo summary returned by Sesión 17's Settings → Repos list.
/// Symbol count is computed via `count_symbols_for_repo`; the other
/// fields come straight off the `repos` row.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RepoSummary {
    pub id:                  String,
    pub path:                String,
    pub name:                String,
    pub opened_at_ms:        i64,
    pub last_indexed_at_ms:  Option<i64>,
    pub indexed_file_count:  i64,
    pub symbol_count:        i64,
    pub replay_enabled:      bool,
}

/// All registered repos with the per-repo metrics the Settings UI shows.
/// One small JOIN — the symbol count is a `COUNT(*)` group-by so we
/// avoid an N+1 round-trip.
pub fn list_repos_with_metrics(store: &Store) -> Result<Vec<RepoSummary>> {
    let conn = store.conn()?;
    let mut stmt = conn.prepare(
        "SELECT r.id, r.path, r.name, r.opened_at, r.last_indexed_at,
                r.indexed_file_count, r.replay_enabled,
                COALESCE(s.cnt, 0) as symbol_count
         FROM   repos r
         LEFT   JOIN (
                    SELECT repo_id, COUNT(*) AS cnt
                    FROM   code_symbols
                    GROUP  BY repo_id
                ) s ON s.repo_id = r.id
         ORDER  BY r.opened_at DESC
         LIMIT  1000",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(RepoSummary {
            id:                 row.get(0)?,
            path:               row.get(1)?,
            name:               row.get(2)?,
            opened_at_ms:       row.get(3)?,
            last_indexed_at_ms: row.get(4)?,
            indexed_file_count: row.get(5)?,
            replay_enabled:     row.get::<_, i64>(6)? != 0,
            symbol_count:       row.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
