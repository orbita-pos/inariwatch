//! SQLite-backed audit log of every tool invocation.
//!
//! One row per [`ToolRegistry::invoke`] call regardless of outcome —
//! success, exec failure, schema invalid, permission denied. The table
//! is created by migration `0011_tool_invocations.sql` on the
//! production code path; tests reach for [`AuditLog::ensure_schema`]
//! to set up the same table on an in-memory pool without running the
//! whole migrator.
//!
//! The sister Witness sidecar (`witness.rs`) provides the cryptographic
//! side of the trail; rows here link to receipts via
//! `witness_receipt_id` (currently the receipt's `args_sha256` —
//! content-addressed so cloud / EAP mirrors can resolve the same row
//! without sharing primary keys).
//!
//! [`ToolRegistry::invoke`]: super::ToolRegistry::invoke

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::store::SqlitePool;

use super::{PermissionDecision, PermissionLevel};

/// One row of `tool_invocations`. Matches the schema in migration
/// `0011_tool_invocations.sql`. Round-trips through serde for the S11
/// audit-log viewer (which reads via the IPC layer that S6 will add).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    /// UUID v4 hex — same id as the `ToolInvocation` and the linked
    /// `WitnessReceipt`.
    pub id: String,
    pub tool_name: String,
    pub session_id: Option<String>,
    /// JSON encoding of the args the model emitted.
    pub args_json: String,
    /// JSON encoding of the tool output, NULL on failure.
    pub result_json: Option<String>,
    pub permission: PermissionLevel,
    pub permission_decision: PermissionDecision,
    /// Hash linking this row to a Witness receipt. NULL if the invoke
    /// short-circuited before the emitter ran (e.g. `UnknownTool`).
    pub witness_receipt_id: Option<String>,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub success: bool,
    pub error: Option<String>,
    /// What triggered the invoke. Migration 0013 adds this column with
    /// DEFAULT 'agent' so existing rows backfill cleanly. Today's
    /// values: "agent" (LLM-decided) | "slash" (user-typed
    /// /<command>). Reserved for future: "manual" (UI confirm-button
    /// click) and "scheduled" (cron / tray Quick Action).
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "agent".to_string()
}

#[derive(Debug, thiserror::Error)]
pub enum AuditError {
    #[error("sqlite: {0}")]
    Sql(String),
    #[error("pool: {0}")]
    Pool(String),
    #[error("decode: {0}")]
    Decode(String),
}

impl AuditError {
    fn sql(e: rusqlite::Error) -> Self {
        Self::Sql(e.to_string())
    }
    fn pool(e: r2d2::Error) -> Self {
        Self::Pool(e.to_string())
    }
}

/// Handle for inserting and listing audit rows. Cloning is cheap (one
/// `SqlitePool` Arc clone).
#[derive(Clone)]
pub struct AuditLog {
    pool: SqlitePool,
}

impl AuditLog {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Idempotent — creates `tool_invocations` + indexes if missing.
    /// Safe to call alongside the production migration runner; the
    /// `CREATE TABLE IF NOT EXISTS` makes both paths agree on the
    /// final schema. Tests use this to skip the full migrator.
    pub fn ensure_schema(&self) -> Result<(), AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;
        conn.execute_batch(SCHEMA_SQL).map_err(AuditError::sql)?;
        Ok(())
    }

    /// Persist one invocation row. The registry calls this after the
    /// witness receipt has closed.
    pub fn insert(&self, entry: &AuditEntry) -> Result<(), AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;
        conn.execute(
            r#"
            INSERT INTO tool_invocations (
                id, tool_name, session_id, args_json, result_json,
                permission, permission_decision, witness_receipt_id,
                started_at_ms, finished_at_ms, success, error, source
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8,
                ?9, ?10, ?11, ?12, ?13
            )
            "#,
            params![
                entry.id,
                entry.tool_name,
                entry.session_id,
                entry.args_json,
                entry.result_json,
                entry.permission.as_str(),
                entry.permission_decision.as_str(),
                entry.witness_receipt_id,
                entry.started_at_ms as i64,
                entry.finished_at_ms as i64,
                if entry.success { 1_i64 } else { 0 },
                entry.error,
                entry.source,
            ],
        )
        .map_err(AuditError::sql)?;
        Ok(())
    }

    pub fn list_recent(&self, limit: u32) -> Result<Vec<AuditEntry>, AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;
        let mut stmt = conn
            .prepare(&format!("{SELECT_BASE} ORDER BY started_at_ms DESC LIMIT ?1"))
            .map_err(AuditError::sql)?;
        let rows = stmt
            .query_map(params![limit as i64], row_to_entry)
            .map_err(AuditError::sql)?;
        collect(rows)
    }

    pub fn list_by_tool(&self, tool: &str, limit: u32) -> Result<Vec<AuditEntry>, AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;
        let mut stmt = conn
            .prepare(&format!(
                "{SELECT_BASE} WHERE tool_name = ?1 ORDER BY started_at_ms DESC LIMIT ?2"
            ))
            .map_err(AuditError::sql)?;
        let rows = stmt
            .query_map(params![tool, limit as i64], row_to_entry)
            .map_err(AuditError::sql)?;
        collect(rows)
    }

    pub fn list_by_session(&self, session_id: &str) -> Result<Vec<AuditEntry>, AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;
        let mut stmt = conn
            .prepare(&format!(
                "{SELECT_BASE} WHERE session_id = ?1 ORDER BY started_at_ms ASC"
            ))
            .map_err(AuditError::sql)?;
        let rows = stmt
            .query_map(params![session_id], row_to_entry)
            .map_err(AuditError::sql)?;
        collect(rows)
    }

    /// Total row count. Diagnostic + tests.
    pub fn count(&self) -> Result<u64, AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM tool_invocations", [], |row| row.get(0))
            .map_err(AuditError::sql)?;
        Ok(n as u64)
    }

    /// Single audit row by id. `Ok(None)` for unknown ids — pure
    /// not-found, not an error. The S11 detail panel reads through this
    /// when the user clicks a row in the filtered list.
    pub fn get_by_id(&self, id: &str) -> Result<Option<AuditEntry>, AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;
        let mut stmt = conn
            .prepare(&format!("{SELECT_BASE} WHERE id = ?1 LIMIT 1"))
            .map_err(AuditError::sql)?;
        let mut rows = stmt
            .query_map(params![id], row_to_entry)
            .map_err(AuditError::sql)?;
        match rows.next() {
            Some(r) => r.map(Some).map_err(AuditError::sql),
            None => Ok(None),
        }
    }

    /// Filtered, paginated read for the S11 audit-log viewer.
    ///
    /// Filter knobs (every field independent — combine freely):
    ///
    /// - `text` — case-insensitive substring across `tool_name`,
    ///   `session_id`, `error`, `args_json`.
    /// - `tool_name` — exact match.
    /// - `success` — `Some(true)` keeps successes, `Some(false)`
    ///   keeps failures, `None` keeps both.
    /// - `session_id` — exact match.
    /// - `since_ms` / `until_ms` — half-open `[since, until)` window on
    ///   `started_at_ms`.
    /// - `cursor_started_at_ms` — pagination cursor; rows STRICTLY
    ///   older (when sort is desc) / newer (asc) are returned. Combined
    ///   with the same filter set on the next call to walk the result
    ///   deeply.
    /// - `limit` — capped at 500 row max so a malicious / buggy caller
    ///   can't drain the table in one go.
    /// - `order` — `NewestFirst` (default; matches the "Tab Timelapse"
    ///   mental model) or `OldestFirst`.
    ///
    /// Returns the rows + a `next_cursor` (the last row's
    /// `started_at_ms`) when more rows exist, plus the total matching
    /// the filter (without pagination) so the UI can render
    /// "Showing 50 of 312". Cursor comparisons strictly exclude the
    /// boundary so successive pages do not double-deliver the row at
    /// the cursor; that's also why we pin to `started_at_ms` ordering
    /// rather than `id` (the UUIDs are random so order isn't stable).
    pub fn list_filtered(&self, filter: &AuditFilter) -> Result<AuditPage, AuditError> {
        let conn = self.pool.get().map_err(AuditError::pool)?;

        let limit = filter.limit.clamp(1, 500) as i64;

        // Build the WHERE clause + bind args. Using a Vec of boxed
        // dynamic params lets us mix String / i64 / bool. The builder
        // is tedious but the SQL stays parameterised — no string
        // interpolation of user input.
        let mut where_parts: Vec<String> = Vec::new();
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(tool) = filter.tool_name.as_ref().filter(|s| !s.is_empty()) {
            where_parts.push(format!("tool_name = ?{}", binds.len() + 1));
            binds.push(Box::new(tool.clone()));
        }
        if let Some(session) = filter.session_id.as_ref().filter(|s| !s.is_empty()) {
            where_parts.push(format!("session_id = ?{}", binds.len() + 1));
            binds.push(Box::new(session.clone()));
        }
        if let Some(success) = filter.success {
            where_parts.push(format!("success = ?{}", binds.len() + 1));
            binds.push(Box::new(if success { 1_i64 } else { 0 }));
        }
        if let Some(since) = filter.since_ms {
            where_parts.push(format!("started_at_ms >= ?{}", binds.len() + 1));
            binds.push(Box::new(since as i64));
        }
        if let Some(until) = filter.until_ms {
            where_parts.push(format!("started_at_ms < ?{}", binds.len() + 1));
            binds.push(Box::new(until as i64));
        }
        if let Some(text) = filter.text.as_ref().filter(|s| !s.is_empty()) {
            // Four columns get the same LIKE pattern. SQLite LIKE is
            // case-insensitive on ASCII by default, which matches the
            // UI promise ("substring search, ASCII case-insensitive").
            let pattern = format!("%{}%", text);
            let n = binds.len() + 1;
            where_parts.push(format!(
                "(tool_name LIKE ?{n} OR coalesce(session_id, '') LIKE ?{n} \
                 OR coalesce(error, '') LIKE ?{n} OR args_json LIKE ?{n})",
            ));
            binds.push(Box::new(pattern));
        }

        // Cursor: STRICT inequality so consecutive pages don't repeat
        // the boundary row. The direction depends on `order`.
        if let Some(cursor) = filter.cursor_started_at_ms {
            let op = match filter.order {
                AuditOrder::NewestFirst => "<",
                AuditOrder::OldestFirst => ">",
            };
            where_parts.push(format!("started_at_ms {op} ?{}", binds.len() + 1));
            binds.push(Box::new(cursor as i64));
        }

        let where_sql = if where_parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", where_parts.join(" AND "))
        };

        let order_sql = match filter.order {
            AuditOrder::NewestFirst => "ORDER BY started_at_ms DESC",
            AuditOrder::OldestFirst => "ORDER BY started_at_ms ASC",
        };

        // Total = same filter, no cursor, no limit. We rebuild the
        // WHERE without the cursor predicate so the count is stable
        // across pages.
        let mut total_where_parts: Vec<String> = Vec::new();
        let mut total_binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(tool) = filter.tool_name.as_ref().filter(|s| !s.is_empty()) {
            total_where_parts.push(format!("tool_name = ?{}", total_binds.len() + 1));
            total_binds.push(Box::new(tool.clone()));
        }
        if let Some(session) = filter.session_id.as_ref().filter(|s| !s.is_empty()) {
            total_where_parts.push(format!("session_id = ?{}", total_binds.len() + 1));
            total_binds.push(Box::new(session.clone()));
        }
        if let Some(success) = filter.success {
            total_where_parts.push(format!("success = ?{}", total_binds.len() + 1));
            total_binds.push(Box::new(if success { 1_i64 } else { 0 }));
        }
        if let Some(since) = filter.since_ms {
            total_where_parts.push(format!("started_at_ms >= ?{}", total_binds.len() + 1));
            total_binds.push(Box::new(since as i64));
        }
        if let Some(until) = filter.until_ms {
            total_where_parts.push(format!("started_at_ms < ?{}", total_binds.len() + 1));
            total_binds.push(Box::new(until as i64));
        }
        if let Some(text) = filter.text.as_ref().filter(|s| !s.is_empty()) {
            let pattern = format!("%{}%", text);
            let n = total_binds.len() + 1;
            total_where_parts.push(format!(
                "(tool_name LIKE ?{n} OR coalesce(session_id, '') LIKE ?{n} \
                 OR coalesce(error, '') LIKE ?{n} OR args_json LIKE ?{n})",
            ));
            total_binds.push(Box::new(pattern));
        }
        let total_where_sql = if total_where_parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", total_where_parts.join(" AND "))
        };

        let total: i64 = {
            let count_sql = format!("SELECT COUNT(*) FROM tool_invocations{total_where_sql}");
            let mut stmt = conn.prepare(&count_sql).map_err(AuditError::sql)?;
            let bind_refs: Vec<&dyn rusqlite::ToSql> =
                total_binds.iter().map(|b| b.as_ref()).collect();
            stmt.query_row(rusqlite::params_from_iter(bind_refs), |row| row.get(0))
                .map_err(AuditError::sql)?
        };

        let sql = format!(
            "{SELECT_BASE}{where_sql} {order_sql} LIMIT ?{}",
            binds.len() + 1
        );
        binds.push(Box::new(limit + 1)); // +1 to peek "is there more?"

        let mut stmt = conn.prepare(&sql).map_err(AuditError::sql)?;
        let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
        let mapped = stmt
            .query_map(rusqlite::params_from_iter(bind_refs), row_to_entry)
            .map_err(AuditError::sql)?;
        let mut rows: Vec<AuditEntry> = collect(mapped)?;

        let next_cursor = if rows.len() as i64 > limit {
            rows.pop(); // drop the peek
            // The last row we kept is the cursor — next page starts
            // strictly past it.
            rows.last().map(|e| e.started_at_ms)
        } else {
            None
        };

        Ok(AuditPage {
            rows,
            next_cursor,
            total: total as u64,
        })
    }
}

/// What "newest first" means for the audit-log viewer's chronological
/// table. Default = `NewestFirst` (the spec's "Tab Timelapse" mental
/// model — most-recent rows at the top, scroll into history).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOrder {
    #[default]
    NewestFirst,
    OldestFirst,
}

/// Filter / pagination payload accepted by [`AuditLog::list_filtered`].
/// `Default` matches the UI's "show me everything, newest first, first
/// page of 50" empty state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuditFilter {
    /// Free-text substring search across `tool_name`, `session_id`,
    /// `error`, and `args_json`. ASCII case-insensitive (SQLite default).
    /// Empty string treated as `None`.
    pub text: Option<String>,
    /// Exact tool name. Empty string treated as `None`.
    pub tool_name: Option<String>,
    /// Filter on success/fail. `None` = both.
    pub success: Option<bool>,
    /// Exact session id. Empty string treated as `None`.
    pub session_id: Option<String>,
    /// Half-open `[since_ms, until_ms)` window on `started_at_ms`.
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    /// Cursor from a previous page's `next_cursor`. Used together with
    /// `order` to walk strictly past the boundary row.
    pub cursor_started_at_ms: Option<u64>,
    /// Page size. Clamped to `[1, 500]`.
    pub limit: u32,
    /// Sort direction.
    pub order: AuditOrder,
}

impl AuditFilter {
    /// Convenience builder — limit defaults to 50, order to
    /// `NewestFirst`. Used by tests and by the IPC layer when the
    /// frontend hasn't supplied a value yet.
    pub fn new() -> Self {
        Self {
            limit: 50,
            ..Self::default()
        }
    }
}

/// One page of audit rows + the cursor + total. `next_cursor=None`
/// signals "this was the last page".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditPage {
    pub rows: Vec<AuditEntry>,
    pub next_cursor: Option<u64>,
    pub total: u64,
}

const SELECT_BASE: &str = r#"
    SELECT
        id, tool_name, session_id, args_json, result_json,
        permission, permission_decision, witness_receipt_id,
        started_at_ms, finished_at_ms, success, error, source
    FROM tool_invocations
"#;

/// Same body as migrations `0011_tool_invocations.sql` +
/// `0013_invocation_source.sql` collapsed into one CREATE.
/// Mirrored here so `ensure_schema()` can run without the migration
/// runner — keeps hermetic tests fast. Update this in lock-step
/// whenever a new tool_invocations migration lands.
const SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS tool_invocations (
        id                  TEXT    PRIMARY KEY,
        tool_name           TEXT    NOT NULL,
        session_id          TEXT,
        args_json           TEXT    NOT NULL,
        result_json         TEXT,
        permission          TEXT    NOT NULL,
        permission_decision TEXT    NOT NULL,
        witness_receipt_id  TEXT,
        started_at_ms       INTEGER NOT NULL,
        finished_at_ms      INTEGER NOT NULL,
        success             INTEGER NOT NULL,
        error               TEXT,
        source              TEXT    NOT NULL DEFAULT 'agent'
    );
    CREATE INDEX IF NOT EXISTS tool_invocations_tool_idx
        ON tool_invocations (tool_name, started_at_ms DESC);
    CREATE INDEX IF NOT EXISTS tool_invocations_session_idx
        ON tool_invocations (session_id, started_at_ms DESC);
    CREATE INDEX IF NOT EXISTS tool_invocations_source_idx
        ON tool_invocations (source, started_at_ms DESC);
"#;

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditEntry> {
    let permission_str: String = row.get(5)?;
    let decision_str: String = row.get(6)?;
    let success_int: i64 = row.get(10)?;
    Ok(AuditEntry {
        id: row.get(0)?,
        tool_name: row.get(1)?,
        session_id: row.get(2)?,
        args_json: row.get(3)?,
        result_json: row.get(4)?,
        permission: PermissionLevel::parse_str(&permission_str).unwrap_or(PermissionLevel::Auto),
        permission_decision: PermissionDecision::parse_str(&decision_str)
            .unwrap_or(PermissionDecision::Allow),
        witness_receipt_id: row.get(7)?,
        started_at_ms: row.get::<_, i64>(8)? as u64,
        finished_at_ms: row.get::<_, i64>(9)? as u64,
        success: success_int != 0,
        error: row.get(11)?,
        source: row.get(12)?,
    })
}

fn collect<I>(rows: I) -> Result<Vec<AuditEntry>, AuditError>
where
    I: Iterator<Item = rusqlite::Result<AuditEntry>>,
{
    rows.map(|r| r.map_err(AuditError::sql)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use r2d2_sqlite::SqliteConnectionManager;

    fn pool() -> SqlitePool {
        // `:memory:` per-connection — the pool will hand out separate
        // databases per acquire, so we pin to a single connection for
        // tests via `max_size(1)`. That matches how the production
        // pool serves the audit log inside one process.
        let manager = SqliteConnectionManager::memory();
        r2d2::Pool::builder()
            .max_size(1)
            .build(manager)
            .expect("memory pool")
    }

    fn entry(id: &str, tool: &str, session: Option<&str>, success: bool) -> AuditEntry {
        AuditEntry {
            id: id.into(),
            tool_name: tool.into(),
            session_id: session.map(str::to_owned),
            args_json: r#"{"k":1}"#.into(),
            result_json: success.then(|| r#"{"ok":true}"#.into()),
            permission: PermissionLevel::Auto,
            permission_decision: PermissionDecision::Allow,
            witness_receipt_id: Some("hash-abc".into()),
            started_at_ms: 1,
            finished_at_ms: 2,
            success,
            error: (!success).then(|| "boom".into()),
            source: "agent".into(),
        }
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let log = AuditLog::new(pool());
        log.ensure_schema().expect("first");
        log.ensure_schema().expect("second");
        assert_eq!(log.count().unwrap(), 0);
    }

    #[test]
    fn insert_round_trips_through_list_recent() {
        let log = AuditLog::new(pool());
        log.ensure_schema().unwrap();

        let row = entry("id-1", "desktop.read_file", Some("s-1"), true);
        log.insert(&row).expect("insert");

        let listed = log.list_recent(10).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], row);
    }

    #[test]
    fn list_by_tool_filters_correctly() {
        let log = AuditLog::new(pool());
        log.ensure_schema().unwrap();

        let mut a = entry("id-1", "desktop.read_file", None, true);
        a.started_at_ms = 100;
        let mut b = entry("id-2", "desktop.read_file", None, true);
        b.started_at_ms = 200;
        let mut c = entry("id-3", "local.run_shell", None, false);
        c.started_at_ms = 300;
        log.insert(&a).unwrap();
        log.insert(&b).unwrap();
        log.insert(&c).unwrap();

        let reads = log.list_by_tool("desktop.read_file", 10).unwrap();
        assert_eq!(reads.len(), 2);
        // started_at_ms DESC
        assert_eq!(reads[0].id, "id-2");
        assert_eq!(reads[1].id, "id-1");

        let shells = log.list_by_tool("local.run_shell", 10).unwrap();
        assert_eq!(shells.len(), 1);
        assert_eq!(shells[0].id, "id-3");
        assert!(!shells[0].success);
        assert_eq!(shells[0].error.as_deref(), Some("boom"));
    }

    #[test]
    fn list_by_session_returns_chronological_order() {
        let log = AuditLog::new(pool());
        log.ensure_schema().unwrap();

        let mut a = entry("id-a", "t", Some("s-1"), true);
        a.started_at_ms = 10;
        let mut b = entry("id-b", "t", Some("s-1"), true);
        b.started_at_ms = 5;
        let mut c = entry("id-c", "t", Some("s-2"), true);
        c.started_at_ms = 1;
        log.insert(&a).unwrap();
        log.insert(&b).unwrap();
        log.insert(&c).unwrap();

        let s1 = log.list_by_session("s-1").unwrap();
        assert_eq!(s1.len(), 2);
        // ASC
        assert_eq!(s1[0].id, "id-b");
        assert_eq!(s1[1].id, "id-a");

        let s2 = log.list_by_session("s-2").unwrap();
        assert_eq!(s2.len(), 1);
        assert_eq!(s2[0].id, "id-c");
    }

    #[test]
    fn list_recent_respects_limit() {
        let log = AuditLog::new(pool());
        log.ensure_schema().unwrap();
        for i in 0..5 {
            let mut e = entry(&format!("id-{i}"), "t", None, true);
            e.started_at_ms = i as u64;
            log.insert(&e).unwrap();
        }
        let listed = log.list_recent(3).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].id, "id-4");
        assert_eq!(listed[2].id, "id-2");
    }

    #[test]
    fn permission_strings_round_trip_through_storage() {
        let log = AuditLog::new(pool());
        log.ensure_schema().unwrap();
        let mut e = entry("id-1", "t", None, true);
        e.permission = PermissionLevel::Confirm;
        e.permission_decision = PermissionDecision::RequiresConfirm;
        log.insert(&e).unwrap();
        let back = log.list_recent(1).unwrap().pop().unwrap();
        assert_eq!(back.permission, PermissionLevel::Confirm);
        assert_eq!(back.permission_decision, PermissionDecision::RequiresConfirm);
    }

    // ── list_filtered + get_by_id ─────────────────────────────────────────

    /// Stage 6 rows representative of the S11 viewer's filter axes:
    /// 4 successes / 2 failures, two tools, two sessions, three
    /// monotonically-increasing timestamps. Used by every list_filtered
    /// test below.
    fn populated_log() -> AuditLog {
        let log = AuditLog::new(pool());
        log.ensure_schema().unwrap();
        let mut rows = Vec::new();
        // (id, tool, session, success, started_at_ms, error)
        let raw = [
            ("a", "desktop.read_file", Some("s1"), true, 100_u64, None),
            ("b", "desktop.read_file", Some("s1"), true, 110, None),
            ("c", "desktop.open_url", Some("s2"), false, 120, Some("boom")),
            ("d", "local.run_shell", Some("s2"), true, 130, None),
            ("e", "local.run_shell", None, false, 140, Some("eperm")),
            ("f", "desktop.notify", Some("s3"), true, 150, None),
        ];
        for (id, tool, session, success, ts, err) in raw {
            let mut e = entry(id, tool, session, success);
            e.started_at_ms = ts;
            e.finished_at_ms = ts + 1;
            e.error = err.map(|s| s.to_string());
            rows.push(e);
        }
        for r in &rows {
            log.insert(r).unwrap();
        }
        log
    }

    #[test]
    fn list_filtered_default_returns_newest_first_with_total() {
        let log = populated_log();
        let page = log.list_filtered(&AuditFilter::new()).unwrap();
        assert_eq!(page.total, 6);
        assert_eq!(page.rows.len(), 6);
        // newest first
        assert_eq!(page.rows[0].id, "f");
        assert_eq!(page.rows[5].id, "a");
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn list_filtered_by_tool_name_filters_correctly() {
        let log = populated_log();
        let page = log
            .list_filtered(&AuditFilter {
                tool_name: Some("desktop.read_file".into()),
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.rows[0].id, "b");
        assert_eq!(page.rows[1].id, "a");
    }

    #[test]
    fn list_filtered_by_success_partitions_rows() {
        let log = populated_log();

        let ok = log
            .list_filtered(&AuditFilter {
                success: Some(true),
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(ok.total, 4);
        assert!(ok.rows.iter().all(|r| r.success));

        let bad = log
            .list_filtered(&AuditFilter {
                success: Some(false),
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(bad.total, 2);
        assert!(bad.rows.iter().all(|r| !r.success));
    }

    #[test]
    fn list_filtered_by_session_id_filters_correctly() {
        let log = populated_log();
        let page = log
            .list_filtered(&AuditFilter {
                session_id: Some("s1".into()),
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(page.total, 2);
        assert!(page.rows.iter().all(|r| r.session_id.as_deref() == Some("s1")));
    }

    #[test]
    fn list_filtered_by_date_range_uses_half_open_window() {
        let log = populated_log();
        let page = log
            .list_filtered(&AuditFilter {
                since_ms: Some(120),
                until_ms: Some(140),
                ..AuditFilter::new()
            })
            .unwrap();
        // [120, 140) → ids c (120) and d (130). e (140) excluded.
        assert_eq!(page.total, 2);
        let ids: Vec<&str> = page.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["d", "c"]);
    }

    #[test]
    fn list_filtered_text_search_matches_across_columns() {
        let log = populated_log();

        // Match against `tool_name`.
        let p = log
            .list_filtered(&AuditFilter {
                text: Some("read_file".into()),
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(p.total, 2);

        // Match against `error`.
        let p = log
            .list_filtered(&AuditFilter {
                text: Some("eperm".into()),
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(p.total, 1);
        assert_eq!(p.rows[0].id, "e");

        // Match against `args_json` (entry()'s default args has `"k":1`).
        let p = log
            .list_filtered(&AuditFilter {
                text: Some(r#""k":1"#.into()),
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(p.total, 6);
    }

    #[test]
    fn list_filtered_paginates_with_stable_total_and_strict_cursor() {
        let log = populated_log();
        let mut filter = AuditFilter {
            limit: 2,
            ..AuditFilter::new()
        };
        let p1 = log.list_filtered(&filter).unwrap();
        assert_eq!(p1.total, 6);
        assert_eq!(p1.rows.len(), 2);
        assert_eq!(p1.rows[0].id, "f");
        assert_eq!(p1.rows[1].id, "e");
        let cursor = p1.next_cursor.expect("more rows");

        filter.cursor_started_at_ms = Some(cursor);
        let p2 = log.list_filtered(&filter).unwrap();
        // Total must NOT shrink due to the cursor — stable across pages.
        assert_eq!(p2.total, 6);
        assert_eq!(p2.rows.len(), 2);
        // Strict cursor (started_at < cursor) means no row repeats.
        assert_eq!(p2.rows[0].id, "d");
        assert_eq!(p2.rows[1].id, "c");

        filter.cursor_started_at_ms = p2.next_cursor;
        let p3 = log.list_filtered(&filter).unwrap();
        assert_eq!(p3.rows.len(), 2);
        assert_eq!(p3.rows[0].id, "b");
        assert_eq!(p3.rows[1].id, "a");
        // Last page → no further cursor.
        assert!(p3.next_cursor.is_none());
    }

    #[test]
    fn list_filtered_oldest_first_inverts_order_and_cursor_direction() {
        let log = populated_log();
        let mut filter = AuditFilter {
            limit: 3,
            order: AuditOrder::OldestFirst,
            ..AuditFilter::new()
        };
        let p1 = log.list_filtered(&filter).unwrap();
        assert_eq!(p1.rows[0].id, "a");
        assert_eq!(p1.rows[2].id, "c");
        filter.cursor_started_at_ms = p1.next_cursor;
        let p2 = log.list_filtered(&filter).unwrap();
        // Strictly past `c` (120) in ASC direction.
        assert_eq!(p2.rows[0].id, "d");
    }

    #[test]
    fn list_filtered_clamps_limit_to_valid_range() {
        let log = populated_log();
        // limit=0 → clamps up to 1.
        let p = log
            .list_filtered(&AuditFilter {
                limit: 0,
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(p.rows.len(), 1);
        // limit=5000 → clamps down to 500. Test corpus only has 6 rows
        // so we just check the call doesn't blow up.
        let p = log
            .list_filtered(&AuditFilter {
                limit: 5000,
                ..AuditFilter::new()
            })
            .unwrap();
        assert_eq!(p.rows.len(), 6);
    }

    #[test]
    fn get_by_id_returns_some_for_known_and_none_for_unknown() {
        let log = populated_log();
        let row = log.get_by_id("c").unwrap().expect("known id");
        assert_eq!(row.id, "c");
        assert!(!row.success);
        assert_eq!(row.error.as_deref(), Some("boom"));

        assert!(log.get_by_id("missing").unwrap().is_none());
    }
}
