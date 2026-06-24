//! `search_codebase` — local. Delegates to the indexer (Session 6).
//! Embeds the query, runs a vec0 KNN over `code_embeddings`, returns
//! the top-K hits with file_path, symbol_name, kind, line range, and
//! cosine similarity. Heavy data flows over the local MCP HTTP
//! transport — never through Tauri IPC.

use serde_json::{json, Value};

use crate::sensors::mcp::error::McpError;
use crate::sensors::mcp::tools::{Tool, ToolContext};

pub struct SearchCodebase;

impl Tool for SearchCodebase {
    fn name(&self) -> &'static str { "search_codebase" }

    fn description(&self) -> &'static str {
        "Search the locally-indexed codebase using semantic vector \
         search (MiniLM-L6-v2, 384-dim). Index is built by the FS \
         sensor + indexer (Session 6). Heavy data flows over the local \
         MCP HTTP transport — it never crosses Tauri IPC."
    }

    fn input_schema(&self) -> Value {
        super::super::schemas::search_codebase()
    }

    fn call(&self, args: &Value, ctx: &ToolContext) -> Result<Value, McpError> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::InvalidParams {
                message: "`query` is required and must be a string".to_string(),
            })?;
        let limit_raw = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5);
        let limit     = limit_raw.min(10) as usize;
        // Optional `project` arg = repo_id filter. Empty / absent =
        // search across all known repos.
        let project = args
            .get("project")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        match crate::indexer::search(&ctx.store, query, limit, project) {
            Ok(hits) => {
                let count = hits.len();
                let results: Vec<Value> = hits.into_iter().map(|h| json!({
                    "repo_id":     h.repo_id,
                    "file_path":   h.file_path,
                    "symbol_name": h.symbol_name,
                    "kind":        h.kind,
                    "line_start":  h.line_start,
                    "line_end":    h.line_end,
                    "similarity":  h.similarity,
                })).collect();
                let summary = if count == 0 {
                    format!("No matches for `{query}`. The repo may not be indexed yet — \
                             run `reindex_codebase` or wait for the FS sensor to bootstrap.")
                } else {
                    format!("Found {count} match{} for `{query}`.",
                            if count == 1 { "" } else { "es" })
                };
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": summary,
                    }],
                    "isError": false,
                    "data": {
                        "ok":      true,
                        "results": results,
                    }
                }))
            }
            Err(e) => {
                tracing::warn!(error = %e, query = %query, "search_codebase failed");
                let reason = match &e {
                    crate::indexer::IndexerError::ModelLoad(msg) => {
                        format!("model not ready: {msg}")
                    }
                    other => format!("indexer error: {other}"),
                };
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!(
                            "search_codebase: {reason}. The dock will retry once \
                             the model finishes loading."
                        )
                    }],
                    "isError": false,
                    "data": {
                        "ok":      false,
                        "reason":  reason,
                        "results": [],
                    }
                }))
            }
        }
    }
}
