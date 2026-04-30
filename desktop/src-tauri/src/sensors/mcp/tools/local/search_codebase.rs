//! `search_codebase` — local. Delegates to the indexer (Session 6).
//! Today the indexer module is an empty skeleton, so the tool returns
//! a structured `IndexerNotReady` envelope. When Session 6 ships, the
//! `crate::indexer::semantic::search(...)` call wires in cleanly.

use serde_json::{json, Value};

use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

pub struct SearchCodebase;

impl Tool for SearchCodebase {
    fn name(&self) -> &'static str { "search_codebase" }

    fn description(&self) -> &'static str {
        "Search the locally-indexed codebase using hybrid vector + \
         keyword search. Index is built by the FS sensor + indexer \
         (Session 6). Heavy data flows over the local MCP HTTP \
         transport — it never crosses Tauri IPC."
    }

    fn input_schema(&self) -> Value {
        super::super::schemas::search_codebase()
    }

    fn call(&self, args: &Value, _ctx: &ToolContext) -> Result<Value, McpError> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::InvalidParams {
                message: "`query` is required and must be a string".to_string(),
            })?;
        let limit_raw = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5);
        let limit     = limit_raw.min(10);

        // Session 6 will replace this block with:
        //   let hits = crate::indexer::semantic::search(
        //       &ctx.store, query, limit as usize,
        //   ).map_err(...)?;
        let _ = (query, limit);

        Ok(json!({
            "content": [{
                "type": "text",
                "text": "search_codebase: indexer not ready. The FS sensor \
                         (Session 5) discovers files; the indexer (Session 6) \
                         builds embeddings + BM25. Until Session 6 ships, this \
                         tool returns no hits but does not error so MCP clients \
                         can still call it."
            }],
            "isError": false,
            "data": {
                "ok":      false,
                "reason":  "indexer not ready (Session 6)",
                "results": [],
            }
        }))
    }
}
