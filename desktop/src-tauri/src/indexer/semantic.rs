//! Semantic search over `code_embeddings`.
//!
//! Used by `crate::sensors::mcp::tools::local::search_codebase` and
//! (future) the dock's command palette. Heavy data flows over the
//! local MCP HTTP transport — never through Tauri IPC.

use serde::Serialize;

use crate::store::{queries, Store};

use super::embeddings::embed_one;
use super::error::Result;

/// Public hit shape exposed to MCP clients. Keep narrow + stringly so
/// the JSON wire shape stays stable as the indexer evolves. This is
/// exactly what `tools/local/search_codebase.rs` returns under
/// `data.results`.
#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub repo_id:     String,
    pub file_path:   String,
    pub symbol_name: String,
    pub kind:        String,
    pub line_start:  u32,
    pub line_end:    u32,
    pub similarity:  f32,
}

/// Cap on how many hits the MCP transport ever returns. Higher than
/// the schema's `limit ≤ 10` so the indexer can over-fetch when
/// post-filtering by `repo_id`. The `tools/local/search_codebase`
/// schema enforces the user-facing 10 cap separately.
pub const MAX_K: usize = 50;

/// Embed the query, run a vec0 KNN search, and post-filter by
/// `repo_id` if provided. Returns at most `k` hits (capped at
/// [`MAX_K`]) sorted by similarity descending.
///
/// Blocking — callers in async contexts should wrap in
/// `tokio::task::spawn_blocking`. Embedding the query is the slow
/// step (~3-8ms on dev box); the SQL KNN itself is sub-millisecond
/// for any realistic index.
pub fn search(
    store:   &Store,
    query:   &str,
    k:       usize,
    repo_id: Option<&str>,
) -> Result<Vec<Hit>> {
    let k = k.min(MAX_K).max(1);
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let qvec = embed_one(trimmed)?;
    let raw  = queries::semantic_search(store, &qvec, k, repo_id)?;

    Ok(raw
        .into_iter()
        .map(|h| Hit {
            repo_id:     h.repo_id,
            file_path:   h.file_path,
            symbol_name: h.symbol_name,
            kind:        h.kind,
            line_start:  h.line_start,
            line_end:    h.line_end,
            similarity:  h.similarity,
        })
        .collect())
}
