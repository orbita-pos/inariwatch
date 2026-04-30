//! Sesión 8 — Bearer auth on `/sensors/git/event` requires the
//! git_hook_token (NOT the MCP Bearer). Wrong / missing → 401.

use std::net::SocketAddr;
use std::sync::Arc;

use inariwatch_desktop_lib::daemon::start_daemon;
use inariwatch_desktop_lib::sensors::git::hooks::{router, GitHookState};
use inariwatch_desktop_lib::store::{queries, Store};
use serde_json::json;

const HOOK_TOKEN: &str = "gh_correct_token_value_xyz";

async fn boot() -> SocketAddr {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    queries::upsert_repo(&store, "repo-1", "/tmp/repo-1", "repo-1", 0).unwrap();
    let daemon = Arc::new(start_daemon());
    let state  = GitHookState {
        daemon,
        store,
        token: HOOK_TOKEN.to_string(),
    };
    let app  = router(state);
    let l    = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    // Leak the tempdir on purpose — the test process exits at the
    // end so the OS reaps it. Keeping the handle would force tests
    // that share the boot helper.
    Box::leak(Box::new(dir));
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    addr
}

#[tokio::test]
async fn missing_bearer_returns_401() {
    let addr = boot().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .json(&json!({"kind":"post_commit","repo_id":"repo-1","ref":"main","sha":"a","diff_size":0}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_bearer_returns_401() {
    let addr = boot().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", "Bearer ilive_this_is_an_mcp_token_not_hook")
        .json(&json!({"kind":"post_commit","repo_id":"repo-1","ref":"main","sha":"a","diff_size":0}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn correct_bearer_returns_200() {
    let addr = boot().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", format!("Bearer {HOOK_TOKEN}"))
        .json(&json!({"kind":"post_commit","repo_id":"repo-1","ref":"main","sha":"a","diff_size":0}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
}
