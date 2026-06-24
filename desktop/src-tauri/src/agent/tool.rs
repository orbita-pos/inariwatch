//! `ChatTool` trait + the value types the registry passes to / from
//! tool implementations. Kept narrow on purpose — we explicitly rejected
//! the OpenClaw "28 optional adapter slots" pattern in favour of one
//! `execute()` and a small `ToolMeta` block.
//!
//! Wire shape is `serde_json::Value` so the trait matches the MCP /
//! function-calling convention every cloud LLM uses. Concrete tools
//! built in S3-S5 are free to use typed args internally — they just
//! deserialize from `invocation.args` at the top of `execute()`.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

use super::PermissionLevel;

/// Fixed metadata about a tool — used by the registry, the permission
/// resolver, and the audit log. Cheap to clone (one short String + a
/// JSON Value handle).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolMeta {
    /// Stable identifier. Used as the registry key, the permission
    /// scope, and the audit-log row. Must be `[a-z0-9_.]+` and unique
    /// across the registry. Convention: namespaced like
    /// `desktop.open_in_editor`, `local.run_shell`, `comm.send_whatsapp`.
    pub name: String,

    /// One-sentence description shown to the model when the tool is
    /// offered. Plain prose, no markdown.
    pub description: String,

    /// JSON Schema for the args payload. Validated on invoke. Use the
    /// minimum schema that captures intent — the LLM does the heavy
    /// lifting.
    pub params_schema: Value,

    /// Default permission level. Concrete tools pick `Auto` for safe
    /// reads, `Confirm` for writes/sends/exec. The user can override
    /// per-tool via settings (handled by `PermissionResolver`).
    pub default_permission: PermissionLevel,
}

/// Snapshot of one tool call as it enters the registry. Carries enough
/// context for permission decisions, witness signing, and audit
/// persistence.
#[derive(Debug, Clone)]
pub struct ToolInvocation {
    /// Unique id assigned by the registry. UUID v4 hex.
    pub id: String,
    /// `tool.name` of the invoked tool.
    pub tool_name: String,
    /// Args as the model emitted them. Already schema-validated by
    /// the registry before this struct is built.
    pub args: Value,
    /// Optional caller-supplied chat session id for cross-call
    /// correlation. Pass-through to the audit log.
    pub session_id: Option<String>,
}

/// What a tool implementation returns. The registry wraps this in a
/// receipt and persists the audit row before handing the value back
/// to the caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    /// Tool's structured result. Echoed back to the chat surface (and
    /// the model). Conventional shape: `{ ok: bool, data?: <tool-specific>,
    /// error?: string }` — not enforced; schema is per-tool.
    pub value: Value,
    /// Optional human-friendly summary the chat surface can render
    /// inline as the tool-call card collapses. Falls back to a JSON
    /// pretty-print when None.
    pub summary: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid args: {0}")]
    InvalidArgs(String),
    #[error("permission denied")]
    PermissionDenied,
    #[error("execution failed: {0}")]
    ExecutionFailed(String),
    #[error("timeout after {0:?}")]
    Timeout(Duration),
    #[error("internal: {0}")]
    Internal(String),
}

/// The contract every tool implements. Keep it narrow — we explicitly
/// rejected the OpenClaw "28 optional adapter slots" pattern in favour
/// of one `execute()` and a small `ToolMeta` block.
#[async_trait]
pub trait ChatTool: Send + Sync + 'static {
    /// Static metadata. Called once at registration time; cheap clones
    /// thereafter.
    fn meta(&self) -> &ToolMeta;

    /// Run the tool. The registry has already:
    ///   - validated args against `meta().params_schema`,
    ///   - resolved a permission decision (Auto/Confirm/Deny),
    ///   - opened a Witness receipt frame.
    ///
    /// Implementations focus purely on the side effect + result. They
    /// MUST NOT perform their own permission checks or audit-log
    /// inserts — the registry does both.
    async fn execute(&self, invocation: &ToolInvocation) -> Result<ToolOutput, ToolError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_meta() -> ToolMeta {
        ToolMeta {
            name: "desktop.open_in_editor".into(),
            description: "Open a file path in the user's default editor.".into(),
            params_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
            default_permission: PermissionLevel::Auto,
        }
    }

    #[test]
    fn tool_meta_round_trips_through_json() {
        let meta = sample_meta();
        let bytes = serde_json::to_vec(&meta).expect("serialize");
        let back: ToolMeta = serde_json::from_slice(&bytes).expect("deserialize");
        assert_eq!(back.name, meta.name);
        assert_eq!(back.description, meta.description);
        assert_eq!(back.params_schema, meta.params_schema);
        assert_eq!(back.default_permission, meta.default_permission);
    }

    #[test]
    fn tool_output_round_trips_through_json() {
        let out = ToolOutput {
            value: json!({ "ok": true, "data": { "path": "/tmp/x" } }),
            summary: Some("Opened /tmp/x".into()),
        };
        let bytes = serde_json::to_vec(&out).expect("serialize");
        let back: ToolOutput = serde_json::from_slice(&bytes).expect("deserialize");
        assert_eq!(back.value, out.value);
        assert_eq!(back.summary, out.summary);
    }

    #[test]
    fn tool_error_display_messages_are_useful() {
        let cases = [
            (
                ToolError::InvalidArgs("missing path".into()),
                "invalid args: missing path",
            ),
            (ToolError::PermissionDenied, "permission denied"),
            (
                ToolError::ExecutionFailed("editor exited 1".into()),
                "execution failed: editor exited 1",
            ),
            (
                ToolError::Internal("unexpected None".into()),
                "internal: unexpected None",
            ),
        ];
        for (err, expected) in cases {
            assert_eq!(err.to_string(), expected);
        }
        // Timeout includes the Duration's debug repr; assert prefix only
        // so the format-impl change in std doesn't break us.
        let timeout = ToolError::Timeout(Duration::from_secs(5));
        assert!(
            timeout.to_string().starts_with("timeout after"),
            "got {timeout}"
        );
    }
}
