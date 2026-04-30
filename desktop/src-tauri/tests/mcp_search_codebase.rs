//! `tools/call` for `search_codebase` — verifies the tool is reachable
//! and returns a structured shape even when the indexer (Session 6)
//! is not wired. This locks the Session 7 contract: the tool never
//! errors hard on a missing indexer; it returns `{ok: false, reason}`.

use std::sync::Arc;

use inariwatch_desktop_lib::daemon::start_daemon;
use inariwatch_desktop_lib::sensors::mcp::{
    auth::AuthState, jsonrpc::Request, server::Server, tools::ToolContext,
};
use inariwatch_desktop_lib::store::Store;
use serde_json::{json, Value};

#[tokio::test]
async fn search_codebase_returns_ok_false_when_indexer_missing() {
    let store_dir = tempfile::tempdir().unwrap();
    let auth_dir  = tempfile::tempdir().unwrap();
    let store     = Arc::new(Store::open_at(&store_dir.path().join("store.db")).unwrap());
    let _auth     = AuthState::from_dir(auth_dir.path().to_path_buf()).unwrap();
    let daemon    = Arc::new(start_daemon());
    let server    = Server::new(ToolContext { store, daemon });

    let req = Request {
        jsonrpc: "2.0".into(),
        id:      Some(json!(7)),
        method:  "tools/call".into(),
        params:  json!({
            "name": "search_codebase",
            "arguments": { "query": "auth flow", "limit": 5 }
        }),
    };
    let resp = server.handle_one(&req);
    assert!(resp.error.is_none(), "search_codebase must not hard-error pre-Session-6");
    let result: Value = resp.result.expect("result");
    let ok = result.pointer("/data/ok").and_then(|v| v.as_bool()).unwrap_or(true);
    assert!(!ok, "result.data.ok should be false until indexer ships");
    let reason = result.pointer("/data/reason")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(
        reason.contains("indexer not ready"),
        "expected 'indexer not ready' reason, got: {reason}"
    );
    let results = result.pointer("/data/results");
    assert_eq!(results, Some(&json!([])));
}

#[tokio::test]
async fn search_codebase_rejects_missing_query() {
    let store_dir = tempfile::tempdir().unwrap();
    let auth_dir  = tempfile::tempdir().unwrap();
    let store     = Arc::new(Store::open_at(&store_dir.path().join("store.db")).unwrap());
    let _auth     = AuthState::from_dir(auth_dir.path().to_path_buf()).unwrap();
    let daemon    = Arc::new(start_daemon());
    let server    = Server::new(ToolContext { store, daemon });

    let req = Request {
        jsonrpc: "2.0".into(),
        id:      Some(json!(8)),
        method:  "tools/call".into(),
        params:  json!({ "name": "search_codebase", "arguments": {} }),
    };
    let resp = server.handle_one(&req);
    let err = resp.error.expect("missing `query` should error");
    assert_eq!(err.code, -32602, "invalid_params");
}
