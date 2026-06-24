//! Sesión 20 — pre_push X-Inari-Bypass header bypasses the runner.
//!
//! Verifies:
//!   1. Response is `allow=true` immediately (no async work spawned).
//!   2. The audit row is persisted with `override_used = 1`.
//!   3. A `GateBypassUsed` event lands on the bus.

use std::net::SocketAddr;
use std::sync::Arc;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent, DaemonHandle};
use inariwatch_desktop_lib::sensors::git::hooks::{router, GitHookState};
use inariwatch_desktop_lib::store::{queries, Store};
use serde_json::{json, Value};

const HOOK_TOKEN: &str = "gh_test_bypass";

async fn boot() -> (SocketAddr, Arc<DaemonHandle>, Arc<Store>, tempfile::TempDir, tempfile::TempDir) {
    let db_dir   = tempfile::tempdir().unwrap();
    let store    = Arc::new(Store::open_at(&db_dir.path().join("store.db")).unwrap());
    let repo_dir = tempfile::tempdir().unwrap();
    queries::upsert_repo(&store, "repo-by", repo_dir.path().to_str().unwrap(), "by", 0).unwrap();
    let daemon = Arc::new(start_daemon());
    let state  = GitHookState {
        daemon: daemon.clone(),
        store:  store.clone(),
        token:  HOOK_TOKEN.to_string(),
        openai: None,
    };
    let app = router(state);
    let l   = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (addr, daemon, store, db_dir, repo_dir)
}

#[tokio::test]
async fn bypass_header_short_circuits_runner_and_marks_audit() {
    let (addr, daemon, store, _db, _repo) = boot().await;
    let bus_rx = daemon.bus.subscribe();
    let client = reqwest::Client::new();

    // Even though the diff has `eval(userInput)` (would fail Gate 9),
    // the bypass header forces an immediate allow.
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", format!("Bearer {HOOK_TOKEN}"))
        .header("X-Inari-Bypass", "1")
        .json(&json!({
            "kind":           "pre_push",
            "repo_id":        "repo-by",
            "ref":            "main",
            "sha":            "abc123",
            "diff_size":      8_usize,
            "diff_body":      "+ eval(userInput);\n",
            "commit_message": "wip",
        }))
        .send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v.get("allow").and_then(|b| b.as_bool()), Some(true), "{v}");

    // Audit row exists with override_used=1.
    let recent = queries::recent_gate_runs(&store, "repo-by", 10).unwrap();
    assert_eq!(recent.len(), 1, "expected one gate_runs row");
    assert!(recent[0].override_used);
    assert!(recent[0].allowed);

    // GateBypassUsed event on the bus.
    let mut saw_bypass = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline && !saw_bypass {
        match tokio::time::timeout(std::time::Duration::from_millis(200), bus_rx.recv_async()).await {
            Ok(Ok(DaemonEvent::GateBypassUsed { .. })) => saw_bypass = true,
            Ok(Ok(_))  => continue,
            Ok(Err(_)) => break,
            Err(_)     => continue,
        }
    }
    assert!(saw_bypass, "GateBypassUsed never observed");
}
