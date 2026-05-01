//! `$/cancelRequest` notification handler.
//!
//! Looks up the pending request by id and signals its cancellation
//! channel. The actual response (an `ErrorResponse` with code -32800)
//! is produced by the request handler that observes the cancel.

use std::sync::Arc;

use serde_json::Value;

use crate::lsp::protocol::RequestId;
use crate::lsp::LspState;

pub fn handle(state: &Arc<LspState>, params: Value) {
    let Some(id) = decode_id(&params) else {
        eprintln!("[lsp] $/cancelRequest with no id field — ignoring");
        return;
    };
    state.cancel(&id);
}

fn decode_id(params: &Value) -> Option<RequestId> {
    let id = params.get("id")?;
    match id {
        Value::Number(n) => n.as_i64().map(RequestId::Number),
        Value::String(s) => Some(RequestId::String(s.clone())),
        _ => None,
    }
}
