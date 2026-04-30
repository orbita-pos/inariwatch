//! MCP-server error types — JSON-RPC 2.0 standard codes plus Inari-Live
//! custom range. Centralized so transports (HTTP / stdio) and tools can
//! produce the same on-the-wire shape.
//!
//! Standard codes per the spec:
//!   -32700  Parse error
//!   -32600  Invalid Request
//!   -32601  Method not found
//!   -32602  Invalid params
//!   -32603  Internal error
//!
//! Custom range (per JSON-RPC, application errors live in -32000 to -32099):
//!   -32001  Unauthorized (missing / wrong Bearer)
//!   -32002  Tool not found
//!   -32003  Tool not yet wired (stub session N)
//!   -32004  Indexer not ready (Session 6 dependency)
//!   -32005  Cloud-only (proxied tool, requires connected workspace)

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum McpError {
    #[serde(rename = "parse_error")]
    ParseError       { message: String },
    #[serde(rename = "invalid_request")]
    InvalidRequest   { message: String },
    #[serde(rename = "method_not_found")]
    MethodNotFound   { method:  String },
    #[serde(rename = "invalid_params")]
    InvalidParams    { message: String },
    #[serde(rename = "internal_error")]
    InternalError    { message: String },
    Unauthorized     { message: String },
    ToolNotFound     { name:    String },
    /// Tool exists in the registry but its real implementation is owned
    /// by a future session. Surfaced as a structured payload so MCP
    /// clients show "not yet wired" instead of a generic failure.
    ToolNotYetWired  { name: String, session: &'static str },
    IndexerNotReady,
    CloudOnly        { name: String },
}

impl McpError {
    pub fn code(&self) -> i32 {
        match self {
            Self::ParseError { .. }      => -32700,
            Self::InvalidRequest { .. }  => -32600,
            Self::MethodNotFound { .. }  => -32601,
            Self::InvalidParams { .. }   => -32602,
            Self::InternalError { .. }   => -32603,
            Self::Unauthorized { .. }    => -32001,
            Self::ToolNotFound { .. }    => -32002,
            Self::ToolNotYetWired { .. } => -32003,
            Self::IndexerNotReady        => -32004,
            Self::CloudOnly { .. }       => -32005,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::ParseError { message }      => format!("Parse error: {message}"),
            Self::InvalidRequest { message }  => format!("Invalid request: {message}"),
            Self::MethodNotFound { method }   => format!("Method not found: {method}"),
            Self::InvalidParams { message }   => format!("Invalid params: {message}"),
            Self::InternalError { message }   => format!("Internal error: {message}"),
            Self::Unauthorized { message }    => format!("Unauthorized: {message}"),
            Self::ToolNotFound { name }       => format!("Unknown tool: {name}"),
            Self::ToolNotYetWired { name, session } => {
                format!("Tool {name} not yet wired (owned by {session})")
            }
            Self::IndexerNotReady => {
                "Indexer not ready: Session 6 has not yet shipped".to_string()
            }
            Self::CloudOnly { name } => {
                format!("{name} requires a connected workspace (cloud-proxied tool)")
            }
        }
    }
}

impl From<serde_json::Error> for McpError {
    fn from(e: serde_json::Error) -> Self {
        McpError::ParseError { message: e.to_string() }
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message(), self.code())
    }
}

impl std::error::Error for McpError {}
