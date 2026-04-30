//! Bearer-token enforcement for the local MCP HTTP transport.
//!
//! - Missing header → 401.
//! - Wrong token   → 401.
//! - Correct token → 200 + JSON-RPC body.
//!
//! `/mcp/health` deliberately bypasses auth so a watchdog can probe
//! liveness without a token.

use std::net::SocketAddr;
use std::sync::Arc;

use inariwatch_desktop_lib::daemon::start_daemon;
use inariwatch_desktop_lib::sensors::mcp::{
    auth::AuthState,
    server::Server,
    tools::ToolContext,
    transport_http::{router, HttpState},
};
use inariwatch_desktop_lib::store::Store;
use serde_json::json;

#[tokio::test]
async fn missing_bearer_returns_401() {
    let (addr, _gd) = boot().await;
    let resp = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_bearer_returns_401() {
    let (addr, _gd) = boot().await;
    let resp = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .header("Authorization", "Bearer ilive_definitely_wrong")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn correct_bearer_returns_200() {
    let (addr, gd) = boot().await;
    let resp = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .header("Authorization", format!("Bearer {}", gd.token))
        .json(&json!({"jsonrpc":"2.0","id":42,"method":"ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body.get("id").unwrap(), &json!(42));
}

#[tokio::test]
async fn health_endpoint_does_not_require_auth() {
    let (addr, _gd) = boot().await;
    let resp = reqwest::Client::new()
        .get(format!("http://{addr}/mcp/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body.get("ok").unwrap(), &json!(true));
}

struct GuardedAuth {
    token: String,
    _store_dir: tempfile::TempDir,
    _auth_dir: tempfile::TempDir,
}

async fn boot() -> (SocketAddr, GuardedAuth) {
    let store_dir = tempfile::tempdir().unwrap();
    let auth_dir  = tempfile::tempdir().unwrap();
    let store     = Arc::new(Store::open_at(&store_dir.path().join("store.db")).unwrap());
    let auth      = AuthState::from_dir(auth_dir.path().to_path_buf()).unwrap();
    let token     = auth.token();
    let daemon    = Arc::new(start_daemon());
    let server    = Server::new(ToolContext { store, daemon });
    let state     = HttpState { server, auth };
    let app       = router(state);

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (addr, GuardedAuth { token, _store_dir: store_dir, _auth_dir: auth_dir })
}
