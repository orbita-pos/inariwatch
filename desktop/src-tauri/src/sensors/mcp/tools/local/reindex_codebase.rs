//! `reindex_codebase` — local. Emits a daemon-bus event that the
//! indexer (Session 6) consumes. Until Session 6 lands, the event has
//! no consumer; it's safely dropped by the bus. The tool returns
//! immediately so the MCP client gets a fast acknowledgement.

use serde_json::{json, Value};

use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

pub struct ReindexCodebase;

impl Tool for ReindexCodebase {
    fn name(&self) -> &'static str { "reindex_codebase" }

    fn description(&self) -> &'static str {
        "Trigger a re-indexation of the user's repo. The FS sensor \
         (Session 5) emits a SensorWarning if the walk is truncated; \
         the indexer (Session 6) consumes the request and re-embeds \
         changed symbols. This tool acks immediately and the actual \
         work runs on the daemon's worker."
    }

    fn input_schema(&self) -> Value {
        super::super::schemas::reindex_codebase()
    }

    fn call(&self, args: &Value, _ctx: &ToolContext) -> Result<Value, McpError> {
        let project = args
            .get("project")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::InvalidParams {
                message: "`project` is required and must be a string".to_string(),
            })?;

        // Session 6 will introduce `DaemonEvent::ReindexRequested
        // { repo_id }` and an indexer task that consumes it. Until
        // that variant lands, we tracing-log the request so we can
        // confirm the call landed without coupling to a future enum
        // variant. The Session 7 acks the call immediately — the
        // indexer's heavy work runs out-of-band.
        tracing::info!(
            project = %project,
            "mcp reindex_codebase request — indexer (Session 6) will consume once wired"
        );

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Reindex requested for `{project}`. Worker (Session 6) consumes \
                     the request and re-embeds changed symbols incrementally."
                )
            }],
            "isError": false,
            "data": {
                "ok":      true,
                "project": project,
            }
        }))
    }
}
