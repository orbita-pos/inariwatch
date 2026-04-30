//! JSON-RPC 2.0 — hand-rolled types matching the wire shape used by
//! `web/app/api/mcp/route.ts`. Keep parity so an MCP client written
//! against the hosted server can talk to the local one without
//! changes.
//!
//! We accept single requests and batch arrays. Responses mirror that
//! shape: a single request returns a single response; a batch returns
//! an array.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::McpError;

pub const PROTOCOL_VERSION: &str = "2024-11-05";
pub const SERVER_NAME:      &str = "inari-live";
pub const SERVER_VERSION:   &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    /// `id` is `null | number | string` per spec. Notifications omit
    /// `id`; we represent that as `None`.
    #[serde(default)]
    pub id:      Option<Value>,
    pub method:  String,
    #[serde(default)]
    pub params:  Value,
}

impl Request {
    pub fn parse(raw: &str) -> Result<RequestBatch, McpError> {
        let value: Value = serde_json::from_str(raw)
            .map_err(|e| McpError::ParseError { message: e.to_string() })?;
        match value {
            Value::Array(arr) => {
                if arr.is_empty() {
                    return Err(McpError::InvalidRequest {
                        message: "empty batch".to_string(),
                    });
                }
                let mut out = Vec::with_capacity(arr.len());
                for v in arr {
                    let req: Request = serde_json::from_value(v)
                        .map_err(|e| McpError::InvalidRequest { message: e.to_string() })?;
                    out.push(req);
                }
                Ok(RequestBatch::Batch(out))
            }
            other => {
                let req: Request = serde_json::from_value(other)
                    .map_err(|e| McpError::InvalidRequest { message: e.to_string() })?;
                Ok(RequestBatch::Single(req))
            }
        }
    }
}

#[derive(Debug, Clone)]
pub enum RequestBatch {
    Single(Request),
    Batch(Vec<Request>),
}

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id:      Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result:  Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error:   Option<ResponseError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResponseError {
    pub code:    i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data:    Option<Value>,
}

impl Response {
    pub fn ok(id: Option<Value>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id:      id.unwrap_or(Value::Null),
            result:  Some(result),
            error:   None,
        }
    }

    pub fn err(id: Option<Value>, err: McpError) -> Self {
        let data = serde_json::to_value(&err).ok();
        Self {
            jsonrpc: "2.0",
            id:      id.unwrap_or(Value::Null),
            result:  None,
            error:   Some(ResponseError {
                code:    err.code(),
                message: err.message(),
                data,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub name:    &'static str,
    pub version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerCapabilities {
    /// Empty objects mark "feature available, no extra config" per the
    /// MCP spec — same as the hosted server emits.
    pub tools:     EmptyMap,
    pub resources: EmptyMap,
    pub prompts:   EmptyMap,
    pub sampling:  EmptyMap,
}

/// Marker type that serializes as `{}`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct EmptyMap {}

#[derive(Debug, Clone, Serialize)]
pub struct InitializeResult {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: &'static str,
    pub capabilities:     ServerCapabilities,
    #[serde(rename = "serverInfo")]
    pub server_info:      ServerInfo,
}

impl InitializeResult {
    pub fn new() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            capabilities: ServerCapabilities {
                tools:     EmptyMap::default(),
                resources: EmptyMap::default(),
                prompts:   EmptyMap::default(),
                sampling:  EmptyMap::default(),
            },
            server_info: ServerInfo {
                name:    SERVER_NAME,
                version: SERVER_VERSION,
            },
        }
    }
}

impl Default for InitializeResult {
    fn default() -> Self { Self::new() }
}
