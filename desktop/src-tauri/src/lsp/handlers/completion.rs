//! `textDocument/completion` handler — Sesión 23 wires this to
//! `LocalAI::generate(.., fim_mode = true)` against Qwen2.5-Coder-1.5B.
//!
//! The handler is naive on purpose. S24 layers smart triggers, ranking,
//! dedup, cache, and indexer-aware context selection on top — see the
//! `// TODO(S24)` markers below.
//!
//! ## Cancellation
//!
//! The cancel pipeline (`tokio::select!` over the `oneshot` `cancel_rx`)
//! is owned by `lsp::mod::run_request` and inherited verbatim from S22.
//! When `cancel_rx` fires, the `work` future drops; that drops the
//! HTTP body stream from `LocalAI::generate`, which closes the
//! connection to the sidecar. Net cancel→response observed: <50ms in
//! `tests/tab_fim_cancel.rs`.
//!
//! ## Failure mode
//!
//! Any error path (no document, no LocalAI, network failure, parse
//! error, sidecar HTTP error) returns an empty `CompletionList` —
//! same contract as the S22 stub. We never propagate a JSON-RPC error
//! for completion failures; an empty list silently degrades and the
//! editor keeps working.

use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::StreamExt;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::local_ai::GenerateOptions;
use crate::lsp::document_sync::utf16_pos_to_byte;
use crate::lsp::fim;
use crate::lsp::protocol::{RequestId, ResponseError, ResponseMessage};
use crate::lsp::LspState;

/// Model id from `local_ai::registry::catalogue()` (Sesión 21).
const QWEN_MODEL_ID: &str = "qwen2.5-coder-1.5b";

/// Completion budget (passed to `LocalAI::generate`).
const FIM_MAX_TOKENS: u32 = 64;

/// Stop sequences. Two newlines means "end of block" in most languages
/// and is a useful bail-out so the model doesn't generate past the
/// current logical scope.
fn fim_stop_seqs() -> Vec<String> {
    vec!["\n\n".to_string()]
}

/// Run the completion request inside the cancel-aware pipeline. Returns
/// a fully-formed `ResponseMessage` (success or `RequestCancelled`).
pub async fn handle(
    state: Arc<LspState>,
    id: RequestId,
    params: Value,
    cancel_rx: oneshot::Receiver<()>,
) -> ResponseMessage {
    let work = compute_completion(state.clone(), params);

    tokio::select! {
        result = work => ResponseMessage::success(id, result),
        _      = cancel_rx => ResponseMessage::fail(id, ResponseError::request_cancelled()),
    }
}

/// Build a completion list. Returns the empty `CompletionList` JSON on
/// any failure path so the editor degrades silently rather than seeing
/// a JSON-RPC error.
async fn compute_completion(state: Arc<LspState>, params: Value) -> Value {
    // Honor the test-only debug delay (preserved from S22 so the
    // `lsp_cancel_request_works.rs` regression keeps observing a
    // genuinely-pending request). Production code never sets this.
    let delay_ms = state.completion_delay_ms();
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }

    // Parse params. Best-effort — missing fields → empty completion.
    let Some(uri) = params
        .get("textDocument")
        .and_then(|td| td.get("uri"))
        .and_then(Value::as_str)
    else {
        return empty_list();
    };
    let line: u32 = params
        .get("position")
        .and_then(|p| p.get("line"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;
    let character: u32 = params
        .get("position")
        .and_then(|p| p.get("character"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;

    let Some(doc) = state.documents.get(uri) else {
        // didOpen never landed for this URI — VS Code occasionally
        // sends completion before didOpen on first paint. Empty list.
        return empty_list();
    };

    let Some(local_ai) = state.local_ai() else {
        // No LocalAI wired yet (e.g., model not downloaded, hardware
        // tier 0). Same UX as S22 stub.
        return empty_list();
    };

    // Position → byte offset (UTF-16 code units → UTF-8 bytes).
    let byte_offset = utf16_pos_to_byte(&doc.text, line, character);

    // TODO(S24): replace ±200 raw lines with indexer-aware context
    // (top-3 relevant symbols prepended, per-language tuning).
    let (prefix, suffix) =
        fim::extract_context(&doc.text, byte_offset, fim::DEFAULT_CONTEXT_LINES);
    let prompt = fim::build_fim_prompt(&prefix, &suffix);

    // TODO(S24): smart triggers — suppress completion in string literals,
    // comments, mid-word positions, inside import blocks where popup is
    // better. Today we always fire.

    let opts = GenerateOptions {
        model_id:   QWEN_MODEL_ID.to_string(),
        prompt,
        max_tokens: FIM_MAX_TOKENS,
        stop_seqs:  fim_stop_seqs(),
        fim_mode:   true,
    };

    let mut stream = match local_ai.generate(opts).await {
        Ok(s)  => s,
        Err(_) => return empty_list(),
    };

    // Accumulate streamed tokens. The mpsc-serialised LSP writer in
    // `lsp::mod::handle_connection` lets future S24 streaming UX (e.g.
    // `$/progress`) interleave token-by-token without re-architecting.
    let mut acc = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(tok) => {
                acc.push_str(&tok.text);
                if tok.finish_reason.is_some() {
                    break;
                }
            }
            Err(_) => return empty_list(),
        }
    }

    if acc.is_empty() {
        return empty_list();
    }

    // TODO(S24): ranking, dedup against next 3 lines, LRU cache on
    // (buffer_hash, position).
    json!({
        "isIncomplete": false,
        "items": [{
            "label":      first_line(&acc),
            "insertText": acc,
            // 1 = CompletionItemKind.Text — generic. S24 promotes this
            // to a more specific kind (Function/Variable/...) once
            // ranking lands.
            "kind":       1,
        }],
    })
}

fn empty_list() -> Value {
    json!({ "isIncomplete": false, "items": [] })
}

/// First line of `s`, or the entire `s` if it has no newline. Used as
/// the editor-facing label so the popup row stays readable.
fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_list_shape_matches_lsp_completionlist() {
        let v = empty_list();
        assert_eq!(v["isIncomplete"], false);
        assert!(v["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn first_line_handles_single_and_multi_line() {
        assert_eq!(first_line("fn add"), "fn add");
        assert_eq!(first_line("fn add\nfn sub"), "fn add");
        assert_eq!(first_line(""), "");
    }
}
