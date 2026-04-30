//! Stub tool — surfaces a structured "not yet wired" response so MCP
//! clients render an actionable message. Used for every cloud-proxied
//! tool until the corresponding session lands.

use serde_json::{json, Value};

use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

/// A stub instance per registry entry. `name` and `description` come
/// straight from SSOT; `session` names the future session that owns
/// the real implementation.
pub struct Stub {
    pub name:         &'static str,
    pub description:  &'static str,
    pub session:      &'static str,
    pub input_schema: Value,
}

impl Tool for Stub {
    fn name(&self) -> &'static str { self.name }
    fn description(&self) -> &'static str { self.description }
    fn input_schema(&self) -> Value { self.input_schema.clone() }

    fn call(&self, _args: &Value, _ctx: &ToolContext) -> Result<Value, McpError> {
        // We return Ok(...) wrapped as MCP `content` rather than an
        // error response so the client renders the explanatory text
        // verbatim. The hosted-server convention is identical: a tool
        // call that "succeeds" with `isError: true` carries the
        // human-facing message in `content[0].text`.
        Ok(json!({
            "content": [{
                "type": "text",
                "text": format!(
                    "{} is not yet wired in the local Inari Live MCP server. \
                     This tool will be implemented in {}. \
                     For now, use the hosted server at mcp.inariwatch.com \
                     for production-only operations.",
                    self.name, self.session
                )
            }],
            "isError": true,
            "_pending": {
                "ok":      false,
                "reason":  "not_yet_wired",
                "session": self.session,
                "tool":    self.name,
            }
        }))
    }
}
