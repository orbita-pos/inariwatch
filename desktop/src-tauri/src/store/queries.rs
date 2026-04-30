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
