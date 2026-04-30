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
