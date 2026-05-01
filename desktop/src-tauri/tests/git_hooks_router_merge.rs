//! Sesión 8 — Confirms the git router merges cleanly with the MCP
//! router via `axum::Router::merge` and that BOTH endpoints
//! (`/mcp/health` from S7 + `/sensors/git/event` from S8) are served
//! by the same listener with no port conflict.

use std::net::SocketAddr;
use std::sync::Arc;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonHandle};
use inariwatch_desktop_lib::sensors::git::hooks::{router as git_router, GitHookState};
use inariwatch_desktop_lib::sensors::mcp::{
    auth::AuthState,
    server::Server,
    tools::ToolContext,
    transport_http::{router as mcp_router, HttpState},
};
use inariwatch_desktop_lib::store::{queries, Store};
use serde_json::{json, Value};

const HOOK_TOKEN: &str = "gh_router_merge";

#[tokio::test]
async fn merged_router_serves_both_endpoints() {
    // Build both routers + merge.
    let store_dir = tempfile::tempdir().unwrap();
    let auth_dir  = tempfile::tempdir().unwrap();
    let store     = Arc::new(Store::open_at(&store_dir.path().join("store.db")).unwrap());
    queries::upsert_repo(&store, "repo-1", "/tmp/repo-1", "repo-1", 0).unwrap();
    let auth      = AuthState::from_dir(auth_dir.path().to_path_buf()).unwrap();
    let mcp_token = auth.token();
    let daemon: Arc<DaemonHandle> = Arc::new(start_daemon());
    let server    = Server::new(ToolContext {
        store:  store.clone(),
        daemon: daemon.clone(),
    });

    let mcp = mcp_router(HttpState { server, auth });
    let git = git_router(GitHookState {
        daemon: daemon.clone(),
        store:  store.clone(),
        token:  HOOK_TOKEN.to_string(),
        openai: None,
    });
    let merged = mcp.merge(git);

    // Bind one ephemeral listener.
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, merged).await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let client = reqwest::Client::new();

    // S7 endpoint reachable.
    let health = client
        .get(format!("http://{addr}/mcp/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), reqwest::StatusCode::OK);
    let v: Value = health.json().await.unwrap();
    assert_eq!(v.get("ok").and_then(|b| b.as_bool()), Some(true));

    // S7 tools/list reachable with MCP Bearer.
    let tools = client
        .post(format!("http://{addr}/mcp"))
        .header("Authorization", format!("Bearer {mcp_token}"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap();
    assert_eq!(tools.status(), reqwest::StatusCode::OK);

    // S8 endpoint reachable on the same listener with the SEPARATE
    // git_hook_token. Critically this proves the two auths don't bleed
    // into each other (S7 Bearer wouldn't satisfy S8 — see auth test).
    let git_evt = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", format!("Bearer {HOOK_TOKEN}"))
        .json(&json!({
            "kind":      "post_commit",
            "repo_id":   "repo-1",
            "ref":       "main",
            "sha":       "abc",
            "diff_size": 0
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(git_evt.status(), reqwest::StatusCode::OK);
}
