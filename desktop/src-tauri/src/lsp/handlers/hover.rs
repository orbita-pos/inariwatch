//! `textDocument/hover` handler — S22 stub.
//!
//! TODO(post-S26): return a `Hover` with the local indexer's symbol
//! summary + the most recent relevant alert from the project.

use serde_json::{json, Value};

pub fn handle(_params: Value) -> Value {
    // LSP allows `null` to signal "no hover at this position".
    json!(null)
}
