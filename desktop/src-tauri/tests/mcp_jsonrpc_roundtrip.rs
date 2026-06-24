//! POST a JSON-RPC `tools/list` to the in-process axum router and
//! assert the response carries all 26 SSOT tools (CLAUDE.md says 25;
//! the registry includes `rollback_vercel` as a legacy alias of
//! `rollback_deploy`, bringing the tally to 26 — Session 7 mirrors
//! SSOT verbatim).

use std::net::SocketAddr;
use std::sync::Arc;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonHandle};
use inariwatch_desktop_lib::sensors::mcp::{
    auth::AuthState,
    server::Server,
    tools::ToolContext,
    transport_http::{router, HttpState},
};
use inariwatch_desktop_lib::store::Store;
use serde_json::{json, Value};

const EXPECTED_TOOL_COUNT: usize = 26;

#[tokio::test]
async fn tools_list_returns_full_registry() {
    let (state, _store_dir, _auth_dir, _daemon) = make_state().await;
    let token = state.auth.token();
    let app   = router(state);

    // Bind an ephemeral local listener so reqwest can hit it.
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind ephemeral");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    // Give the listener a moment.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let client = reqwest::Client::new();
    let body   = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let resp   = client
        .post(format!("http://{addr}/mcp"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await
        .expect("post tools/list");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let v: Value = resp.json().await.expect("response json");
    let tools = v.pointer("/result/tools").expect("tools array");
    let arr = tools.as_array().expect("array");
    assert_eq!(
        arr.len(),
        EXPECTED_TOOL_COUNT,
        "expected {EXPECTED_TOOL_COUNT} tools in tools/list, got {}", arr.len()
    );

    // Confirm a real tool name is present and a stub one too.
    let names: Vec<String> = arr.iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect();
    assert!(names.contains(&"get_status".to_string()), "real tool `get_status` missing");
    assert!(names.contains(&"trigger_fix".to_string()), "stub tool `trigger_fix` missing");
    assert!(names.contains(&"rollback_vercel".to_string()), "legacy alias missing");
}

#[tokio::test]
async fn initialize_returns_protocol_version() {
    let (state, _, _, _daemon) = make_state().await;
    let server = state.server.clone();
    let req    = inariwatch_desktop_lib::sensors::mcp::jsonrpc::Request {
        jsonrpc: "2.0".to_string(),
        id:      Some(json!(1)),
        method:  "initialize".to_string(),
        params:  Value::Null,
    };
    let resp = server.handle_one(&req);
    assert!(resp.error.is_none(), "initialize should succeed");
    let result = resp.result.expect("initialize result");
    let pv = result.get("protocolVersion").and_then(|s| s.as_str()).unwrap_or("");
    assert_eq!(pv, "2024-11-05");
    let name = result.pointer("/serverInfo/name").and_then(|s| s.as_str()).unwrap_or("");
    assert_eq!(name, "inari-live");
}

#[tokio::test]
async fn ping_returns_empty_object() {
    let (state, _, _, _daemon) = make_state().await;
    let server = state.server.clone();
    let req    = inariwatch_desktop_lib::sensors::mcp::jsonrpc::Request {
        jsonrpc: "2.0".to_string(),
        id:      Some(json!("p")),
        method:  "ping".to_string(),
        params:  Value::Null,
    };
    let resp = server.handle_one(&req);
    let result = resp.result.expect("ping result");
    assert_eq!(result, json!({}));
}

#[tokio::test]
async fn unknown_method_returns_method_not_found() {
    let (state, _, _, _daemon) = make_state().await;
    let server = state.server.clone();
    let req = inariwatch_desktop_lib::sensors::mcp::jsonrpc::Request {
        jsonrpc: "2.0".to_string(),
        id:      Some(json!(7)),
        method:  "fictional/method".to_string(),
        params:  Value::Null,
    };
    let resp = server.handle_one(&req);
    let err = resp.error.expect("error");
    assert_eq!(err.code, -32601, "method_not_found");
}

async fn make_state() -> (
    HttpState,
    tempfile::TempDir,
    tempfile::TempDir,
    Arc<DaemonHandle>,
) {
    let store_dir = tempfile::tempdir().unwrap();
    let auth_dir  = tempfile::tempdir().unwrap();
    let store     = Arc::new(Store::open_at(&store_dir.path().join("store.db")).unwrap());
    let auth      = AuthState::from_dir(auth_dir.path().to_path_buf()).unwrap();
    let daemon    = Arc::new(start_daemon());
    let server    = Server::new(ToolContext {
        store:  store.clone(),
        daemon: daemon.clone(),
    });
    (HttpState { server, auth }, store_dir, auth_dir, daemon)
}
