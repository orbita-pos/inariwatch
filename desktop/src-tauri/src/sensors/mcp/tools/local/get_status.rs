//! `get_status` — local. Wraps the daemon's status snapshot. Mirrors
//! the hosted server's shape (a project list with alert counts), but
//! returns a single "local" project entry today since there's no
//! workspace context until the user connects.

use serde_json::{json, Value};

use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

pub struct GetStatus;

impl Tool for GetStatus {
    fn name(&self) -> &'static str { "get_status" }

    fn description(&self) -> &'static str {
        "List Inari Live's local view of your projects with daemon \
         heartbeat data. Cloud project alert counts come from \
         `mcp.inariwatch.com` for connected workspaces."
    }

    fn input_schema(&self) -> Value {
        super::super::schemas::empty()
    }

    fn call(&self, _args: &Value, ctx: &ToolContext) -> Result<Value, McpError> {
        let snap = ctx.daemon.state.snapshot();
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "Inari Live daemon: uptime={}s sensors={} repos={}",
                    snap.uptime_secs, snap.sensor_count, snap.repo_count
                )
            }],
            "isError": false,
            "data": {
                "uptime_secs":  snap.uptime_secs,
                "sensor_count": snap.sensor_count,
                "repo_count":   snap.repo_count,
            }
        }))
    }
}
