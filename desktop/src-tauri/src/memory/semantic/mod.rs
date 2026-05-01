//! Semantic memory — Layer 1 of the 4-layer memory stack.
//!
//! This is the public memory-layer surface for the indexer's pgvector-
//! style code search. The actual embedding + KNN logic lives in
//! `crate::indexer::semantic`; this module is the seam every memory
//! consumer (Sesión 19 remediation context-gather, future MCP tools,
//! the dock command palette) reaches through so the layering stays
//! explicit:
//!
//!   memory::semantic    ← consumers
//!         │
//!         ▼
//!   indexer::semantic   ← embed_one + queries::semantic_search
//!
//! The wrapper exists for two reasons:
//!   1. **Async hygiene.** The indexer's `search` is blocking
//!      (fastembed inference is CPU-bound, ~3-8 ms on the dev box).
//!      Callers in async contexts shouldn't block the reactor; we
//!      always go through `tokio::task::spawn_blocking` here so the
//!      seam is honest.
//!   2. **Re-exporting [`Hit`].** Memory-layer consumers should depend
//!      on `crate::memory::semantic::Hit`, not the indexer module
//!      directly. Re-exporting keeps the public API at the layer
//!      boundary stable as the indexer evolves internally.

use std::sync::Arc;

use crate::store::Store;

use super::error::{MemoryError, Result};

/// Semantic search hit — re-exported from the indexer so memory-layer
/// callers don't have to import `crate::indexer`.
pub use crate::indexer::semantic::Hit;

/// Re-export the indexer's hard cap so callers can size their `k`
/// arguments against the real ceiling without a second import.
pub use crate::indexer::semantic::MAX_K;

/// Embed `query`, run a KNN over `code_embeddings`, optionally filter
/// by `repo_id`, and return at most `k` hits sorted by similarity
/// descending. `k` is clamped to [`MAX_K`].
///
/// Empty / whitespace-only queries return `Ok(Vec::new())` without
/// touching the embedder.
///
/// Runs the blocking work on `tokio::task::spawn_blocking` so the
/// caller's async runtime stays unblocked. Sub-50ms target on a 50k-
/// symbol index assumes the MiniLM model is already cached + loaded;
/// the first call after process boot pays an extra ~1-3s for model
/// load (one-time, amortized).
pub async fn search(
    store:   &Arc<Store>,
    query:   &str,
    k:       usize,
    repo_id: Option<&str>,
) -> Result<Vec<Hit>> {
    let store_clone = store.clone();
    let query       = query.to_string();
    let repo_owned  = repo_id.map(str::to_owned);

    let join = tokio::task::spawn_blocking(move || {
        crate::indexer::semantic::search(
            &store_clone,
            &query,
            k,
            repo_owned.as_deref(),
        )
    })
    .await
    .map_err(|e| MemoryError::Internal(format!("spawn_blocking join: {e}")))?;

    join.map_err(|e| MemoryError::Internal(format!("indexer search: {e}")))
}
