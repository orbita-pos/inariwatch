//! `tools/call` for `search_codebase` — verifies the tool is reachable
//! and returns a structured shape. Now that the indexer (Session 6)
//! is wired, an empty index returns `{ok: true, results: []}` rather
//! than the pre-Session-6 stub. Embedding the query loads the model
//! lazily — these tests skip embedding by hitting an empty index
//! through the `search_codebase` shape only when fastembed has the
//! model cached. We assert the tool's shape, not the model load.

use std::sync::Arc;

use inariwatch_desktop_lib::daemon::start_daemon;
use inariwatch_desktop_lib::sensors::mcp::{
    auth::AuthState, jsonrpc::Request, server::Server, tools::ToolContext,
};
use inariwatch_desktop_lib::store::Store;
use serde_json::{json, Value};

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

#[tokio::test]
async fn reindex_codebase_publishes_reindex_requested() {
    use inariwatch_desktop_lib::daemon::DaemonEvent;

    let store_dir = tempfile::tempdir().unwrap();
    let auth_dir  = tempfile::tempdir().unwrap();
    let store     = Arc::new(Store::open_at(&store_dir.path().join("store.db")).unwrap());
    let _auth     = AuthState::from_dir(auth_dir.path().to_path_buf()).unwrap();
    let daemon    = Arc::new(start_daemon());
    let bus_rx    = daemon.bus.subscribe();
    let server    = Server::new(ToolContext { store, daemon });

    let req = Request {
        jsonrpc: "2.0".into(),
        id:      Some(json!(9)),
        method:  "tools/call".into(),
        params:  json!({
            "name": "reindex_codebase",
            "arguments": { "project": "test-repo-A" }
        }),
    };
    let resp = server.handle_one(&req);
    assert!(resp.error.is_none(), "reindex_codebase must succeed");
    let result: Value = resp.result.expect("result");
    let ok = result.pointer("/data/ok").and_then(|v| v.as_bool()).unwrap_or(false);
    assert!(ok, "data.ok must be true after wiring");

    // Drain the bus — at minimum we expect a ReindexRequested for our repo.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut saw = false;
    while std::time::Instant::now() < deadline {
        if let Ok(ev) = bus_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            if let DaemonEvent::ReindexRequested { repo_id } = ev {
                if repo_id == "test-repo-A" {
                    saw = true;
                    break;
                }
            }
        }
    }
    assert!(saw, "expected DaemonEvent::ReindexRequested on the bus");
}
