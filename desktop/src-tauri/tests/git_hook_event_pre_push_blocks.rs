//! Sesión 8 — pre_push posts: oversize diff fails Gate 4, small diff
//! passes. The handler runs synchronously and returns the verdict in
//! `{allow, reason, verdicts}` shape.

use std::net::SocketAddr;
use std::sync::Arc;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonHandle};
use inariwatch_desktop_lib::sensors::git::hooks::{router, GitHookState};
use inariwatch_desktop_lib::store::{queries, Store};
use serde_json::{json, Value};

const HOOK_TOKEN: &str = "gh_test1234567890";

async fn boot_router() -> (SocketAddr, Arc<DaemonHandle>, Arc<Store>, tempfile::TempDir) {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    queries::upsert_repo(&store, "repo-1", "/tmp/repo-1", "repo-1", 0).unwrap();
    let daemon = Arc::new(start_daemon());
    let state  = GitHookState {
        daemon: daemon.clone(),
        store:  store.clone(),
        token:  HOOK_TOKEN.to_string(),
        // Sesión 20 — `openai = None` keeps Gate 5 deferred so this
        // S8 contract test stays focused on Gates 1 + 4 (the inline
        // ones) without needing a mock OpenAI server.
        openai: None,
    };
    let app  = router(state);
    let l    = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    (addr, daemon, store, dir)
}

#[tokio::test]
async fn small_diff_pre_push_is_allowed() {
    let (addr, _daemon, _store, _dir) = boot_router().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", format!("Bearer {HOOK_TOKEN}"))
        .json(&json!({
            "kind":      "pre_push",
            "repo_id":   "repo-1",
            "ref":       "main",
            "sha":       "abc",
            "diff_size": 25_usize,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v.get("allow").and_then(|b| b.as_bool()), Some(true), "{v}");
}

#[tokio::test]
async fn oversize_diff_pre_push_is_blocked() {
    let (addr, _daemon, _store, _dir) = boot_router().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", format!("Bearer {HOOK_TOKEN}"))
        .json(&json!({
            "kind":      "pre_push",
            "repo_id":   "repo-1",
            "ref":       "main",
            "sha":       "abc",
            "diff_size": 50_000_usize,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v.get("allow").and_then(|b| b.as_bool()), Some(false), "{v}");
    let reason = v.get("reason").and_then(|s| s.as_str()).unwrap_or("");
    assert!(reason.contains("Gate 4"), "expected Gate 4 reason, got {reason}");
}
