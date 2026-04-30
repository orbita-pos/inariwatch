//! `query_alerts` — local. Reads from the `events` table where
//! `kind LIKE 'alert%'`. The episodic memory layer (Session 13) writes
//! these rows; until then, the table is naturally empty so the tool
//! returns `[]` instead of failing.

use serde_json::{json, Value};

use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

pub struct QueryAlerts;

impl Tool for QueryAlerts {
    fn name(&self) -> &'static str { "query_alerts" }

    fn description(&self) -> &'static str {
        "Query alerts captured in Inari Live's local episodic memory. \
         Filters by severity and limit. Returns up to 100 rows."
    }

    fn input_schema(&self) -> Value {
        super::super::schemas::query_alerts()
    }

    fn call(&self, args: &Value, ctx: &ToolContext) -> Result<Value, McpError> {
        let severity = args
            .get("severity")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let limit_raw = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20);
        let limit = limit_raw.min(100) as i64;

        let conn = ctx.store.conn().map_err(|e| McpError::InternalError {
            message: format!("store connection failed: {e}"),
        })?;

        // Episodic memory writes events with kind names like
        // `alert_received`, `alert_resolved`, etc. (Session 13). We
        // accept any kind starting with `alert` and surface the
        // payload verbatim — the schema is stabilized in Session 13.
        let query = if severity.is_some() {
            "SELECT id, timestamp, kind, repo_id, payload \
             FROM events \
             WHERE kind LIKE 'alert%' \
               AND json_extract(payload, '$.severity') = ?1 \
             ORDER BY timestamp DESC LIMIT ?2"
        } else {
            "SELECT id, timestamp, kind, repo_id, payload \
             FROM events \
             WHERE kind LIKE 'alert%' \
             ORDER BY timestamp DESC LIMIT ?1"
        };

        let mut stmt = conn.prepare(query).map_err(|e| McpError::InternalError {
            message: format!("prepare failed: {e}"),
        })?;

        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            let id:        i64            = row.get(0)?;
            let timestamp: i64            = row.get(1)?;
            let kind:      String         = row.get(2)?;
            let repo_id:   Option<String> = row.get(3)?;
            let payload:   String         = row.get(4)?;
            let payload_val: Value =
                serde_json::from_str(&payload).unwrap_or(Value::String(payload));
            Ok(json!({
                "id":        id,
                "timestamp": timestamp,
                "kind":      kind,
                "repo_id":   repo_id,
                "payload":   payload_val,
            }))
        };

        let rows: Vec<Value> = if let Some(sev) = severity.as_deref() {
            stmt.query_map(rusqlite::params![sev, limit], map_row)
                .and_then(Iterator::collect)
        } else {
            stmt.query_map(rusqlite::params![limit], map_row)
                .and_then(Iterator::collect)
        }
        .map_err(|e| McpError::InternalError { message: format!("query failed: {e}") })?;

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("Returned {} alert event(s) from local episodic memory.", rows.len())
            }],
            "isError": false,
            "data": rows,
        }))
    }
}
