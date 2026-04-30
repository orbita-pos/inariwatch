//! `reindex_codebase` — local. Publishes
//! [`crate::daemon::DaemonEvent::ReindexRequested`] on the bus; the
//! indexer (Session 6) consumes the request and re-walks the repo
//! out-of-band.

use serde_json::{json, Value};

use crate::daemon::DaemonEvent;
use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

pub struct ReindexCodebase;

impl Tool for ReindexCodebase {
    fn name(&self) -> &'static str { "reindex_codebase" }

    fn description(&self) -> &'static str {
        "Trigger a re-indexation of the user's repo. Publishes \
         `ReindexRequested` on the daemon bus; the indexer consumes \
         it asynchronously, re-walks the repo, re-parses, and \
         re-embeds changed symbols. The tool acks immediately — the \
         actual work runs on the daemon's worker."
    }

    fn input_schema(&self) -> Value {
        super::super::schemas::reindex_codebase()
    }

    fn call(&self, args: &Value, ctx: &ToolContext) -> Result<Value, McpError> {
        let project = args
            .get("project")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::InvalidParams {
                message: "`project` is required and must be a string".to_string(),
            })?;

        ctx.daemon.bus.publish(DaemonEvent::ReindexRequested {
            repo_id: project.to_string(),
        });
        tracing::info!(project = %project, "mcp reindex_codebase published ReindexRequested");

        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Reindex requested for `{project}`. The indexer will re-walk \
                     the repo, re-parse changed files, and re-embed any symbols \
                     whose AST hash has changed. Watch for `SymbolsIndexed` on \
                     the bus when the bootstrap completes."
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
