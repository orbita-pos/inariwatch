//! `initialize` request handler. Returns the static capability set the
//! S22 server advertises. Capabilities not implemented yet are simply
//! omitted (LSP clients treat absent capabilities as unsupported).

use serde_json::{json, Value};

/// LSP server name + version surfaced in `initialize` results.
pub const SERVER_NAME: &str = "inari-lsp";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Build the `InitializeResult` payload.
///
/// `textDocumentSync.change = 2` means **Incremental**; full-document
/// replacements still arrive as `contentChanges` entries with no `range`,
/// which `DocumentStore::apply_changes` accepts.
pub fn handle(_params: Value) -> Value {
    json!({
        "capabilities": {
            "textDocumentSync": {
                "openClose": true,
                "change":    2,
            },
            "completionProvider": {
                "resolveProvider": false,
                "triggerCharacters": ["."]
            },
            "codeActionProvider": true,
            "hoverProvider":      true,
            "positionEncoding":   "utf-16"
        },
        "serverInfo": {
            "name":    SERVER_NAME,
            "version": SERVER_VERSION,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_advertise_s22_surface() {
        let v = handle(Value::Null);
        let caps = &v["capabilities"];
        assert_eq!(caps["textDocumentSync"]["change"], 2);
        assert!(caps["completionProvider"].is_object());
        assert_eq!(caps["codeActionProvider"], true);
        assert_eq!(caps["hoverProvider"], true);
        assert_eq!(caps["positionEncoding"], "utf-16");
        assert_eq!(v["serverInfo"]["name"], SERVER_NAME);
    }
}
