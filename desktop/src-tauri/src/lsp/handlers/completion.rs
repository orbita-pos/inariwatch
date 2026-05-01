//! `textDocument/completion` handler.
//!
//! S22 returns an empty list (no model yet) but routes through the same
//! cancel-aware pipeline Sesión 23 will use, so the only delta in S23 is
//! swapping `compute_stub()` for `LocalAI::generate(.., fim_mode=true)`.
//!
//! TODO(S23): replace the stub with `LocalAI::generate(model_id="qwen-1.5b",
//! prompt, max_tokens=64, stop_seqs=["\n\n"], fim_mode=true)` and stream
//! tokens into a single `CompletionItem`. See HANDOFF v0.2 § Sesión 23.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::lsp::protocol::{RequestId, ResponseError, ResponseMessage};
use crate::lsp::LspState;

/// Run the completion request inside the cancel-aware pipeline. Returns a
/// fully-formed `ResponseMessage` (success or `RequestCancelled`).
pub async fn handle(
    state: Arc<LspState>,
    id: RequestId,
    _params: Value,
    cancel_rx: oneshot::Receiver<()>,
) -> ResponseMessage {
    // S22: parse-but-ignore — we only need the document URI for the
    // future S23 hook. We accept malformed params silently to keep the
    // cancel test reliable (the test sends minimal params).

    let work = compute_stub(state.clone());

    tokio::select! {
        result = work => ResponseMessage::success(id, result),
        _      = cancel_rx => ResponseMessage::fail(id, ResponseError::request_cancelled()),
    }
}

/// Stub completion. Returns an empty `CompletionList`. Honours the
/// per-state debug delay (used by `lsp_cancel_request_works.rs` to make
/// the request observably pending).
async fn compute_stub(state: Arc<LspState>) -> Value {
    let delay_ms = state.completion_delay_ms();
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
    json!({ "isIncomplete": false, "items": [] })
}
