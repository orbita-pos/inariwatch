//! Server orchestrator — owns the tool registry, dispatches JSON-RPC
//! requests, and surfaces a transport-agnostic `handle()` entrypoint
//! that both `transport_http` and `transport_stdio` call.
//!
//! The server holds an `Arc` over the registry + tool context so the
//! HTTP listener can stay sync-friendly while the daemon is async.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use super::error::McpError;
use super::jsonrpc::{InitializeResult, Request, RequestBatch, Response};
use super::tools::{registry, Tool, ToolContext};

/// Read-only orchestrator. Cloning is cheap (everything is `Arc`).
#[derive(Clone)]
pub struct Server {
    tools: Arc<HashMap<&'static str, Arc<dyn Tool>>>,
    ctx:   ToolContext,
}

impl Server {
    pub fn new(ctx: ToolContext) -> Self {
        let mut map: HashMap<&'static str, Arc<dyn Tool>> = HashMap::new();
        for tool in registry() {
            // Convert Box<dyn Tool> → Arc<dyn Tool>. This is one
            // allocation at startup; tools are dispatched by reference
            // afterwards.
            let tool: Arc<dyn Tool> = Arc::from(tool);
            map.insert(tool.name(), tool);
        }
        Self {
            tools: Arc::new(map),
            ctx,
        }
    }

    pub fn tool_names(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self.tools.keys().copied().collect();
        names.sort();
        names
    }

    pub fn tool_count(&self) -> usize {
        self.tools.len()
    }

    /// Top-level JSON-RPC entrypoint. Parses, dispatches, and returns
    /// the wire response (single or batch). Notifications (no `id`)
    /// are still answered with a Response so the transport layer can
    /// return _something_ — the spec lets us either drop them or
    /// reply; replying is simpler.
    pub fn handle_raw(&self, raw: &str) -> Value {
        match Request::parse(raw) {
            Ok(RequestBatch::Single(req)) => {
                serde_json::to_value(self.handle_one(&req)).unwrap_or(Value::Null)
            }
            Ok(RequestBatch::Batch(reqs)) => {
                let responses: Vec<Response> = reqs
                    .iter()
                    .map(|r| self.handle_one(r))
                    .collect();
                serde_json::to_value(responses).unwrap_or(Value::Null)
            }
            Err(err) => {
                serde_json::to_value(Response::err(None, err)).unwrap_or(Value::Null)
            }
        }
    }

    pub fn handle_one(&self, req: &Request) -> Response {
        if req.jsonrpc != "2.0" {
            return Response::err(req.id.clone(), McpError::InvalidRequest {
                message: format!("expected jsonrpc=2.0, got {:?}", req.jsonrpc),
            });
        }

        match req.method.as_str() {
            "initialize" => {
                let result = serde_json::to_value(InitializeResult::new())
                    .unwrap_or(Value::Null);
                Response::ok(req.id.clone(), result)
            }
            "ping" => Response::ok(req.id.clone(), json!({})),
            "tools/list" => {
                let tools: Vec<Value> = registry()
                    .iter()
                    .map(|t| json!({
                        "name":        t.name(),
                        "description": t.description(),
                        "inputSchema": t.input_schema(),
                    }))
                    .collect();
                Response::ok(req.id.clone(), json!({ "tools": tools }))
            }
            "tools/call" => self.dispatch_tool(req),
            "resources/list" => {
                // Local server exposes no resources today (Sessions
                // 11/12 will surface .inari/memory.md etc.). Return
                // empty list so MCP clients don't error.
                Response::ok(req.id.clone(), json!({ "resources": [] }))
            }
            "prompts/list" => {
                Response::ok(req.id.clone(), json!({ "prompts": [] }))
            }
            "sampling/createMessage" => {
                // Ack-only (no persistence today; Session 18 wires
                // the AI client and stores aiReasoning locally).
                Response::ok(req.id.clone(), json!({
                    "role": "assistant",
                    "content": { "type": "text", "text": "Acknowledged." },
                    "model": "client-provided"
                }))
            }
            other => Response::err(
                req.id.clone(),
                McpError::MethodNotFound { method: other.to_string() },
            ),
        }
    }

    fn dispatch_tool(&self, req: &Request) -> Response {
        let params = &req.params;
        let name = match params.get("name").and_then(|v| v.as_str()) {
            Some(n) => n.to_string(),
            None    => {
                return Response::err(req.id.clone(), McpError::InvalidParams {
                    message: "tools/call requires `name`".to_string(),
                });
            }
        };
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);

        let tool = match self.tools.get(name.as_str()) {
            Some(t) => t.clone(),
            None    => {
                return Response::err(req.id.clone(), McpError::ToolNotFound { name });
            }
        };

        match tool.call(&args, &self.ctx) {
            Ok(result) => Response::ok(req.id.clone(), result),
            Err(err)   => Response::err(req.id.clone(), err),
        }
    }
}
