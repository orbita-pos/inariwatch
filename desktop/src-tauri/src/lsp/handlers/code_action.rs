//! `textDocument/codeAction` handler — S22 stub.
//!
//! TODO(post-S26): wire to the agentic-loop's `proposeFix` flow so the
//! editor surfaces "Fix it" + "Apply suggestion" code actions.

use serde_json::{json, Value};

pub fn handle(_params: Value) -> Value {
    json!([])
}
