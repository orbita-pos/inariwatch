//! Sesión 8 — `post_merge` POST publishes `DaemonEvent::ReindexRequested`
//! on the bus so the indexer (Sesión 6) re-walks after `git pull`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent};
use inariwatch_desktop_lib::sensors::git::hooks::{router, GitHookState};
use inariwatch_desktop_lib::store::{queries, Store};
use serde_json::json;

const HOOK_TOKEN: &str = "gh_post_merge_test";

#[tokio::test]
async fn post_merge_publishes_reindex_requested() {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());
    queries::upsert_repo(&store, "repo-pm", "/tmp/repo-pm", "repo-pm", 0).unwrap();
    let daemon = Arc::new(start_daemon());

    // Subscribe BEFORE we POST so we don't race the publish.
    let rx = daemon.bus.subscribe();

    let state  = GitHookState {
        daemon: daemon.clone(),
        store:  store.clone(),
        token:  HOOK_TOKEN.to_string(),
    };
    let app  = router(state);
    let l    = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", format!("Bearer {HOOK_TOKEN}"))
        .json(&json!({
            "kind":      "post_merge",
            "repo_id":   "repo-pm",
            "ref":       "main",
            "sha":       "deadbeef",
            "diff_size": 0,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    // Drain the bus until we see ReindexRequested. Timeout-bounded so
    // a regression doesn't hang CI.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut found_reindex = false;
    let mut found_git_event = false;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(DaemonEvent::ReindexRequested { repo_id }) if repo_id == "repo-pm" => {
                found_reindex = true;
                if found_git_event { break; }
            }
            Ok(DaemonEvent::GitEvent { repo_id, .. }) if repo_id == "repo-pm" => {
                found_git_event = true;
                if found_reindex { break; }
            }
            Ok(_)  => continue,
            Err(_) => continue,
        }
    }
    assert!(found_reindex,    "ReindexRequested never published after post_merge");
    assert!(found_git_event,  "GitEvent never published after post_merge");
}
