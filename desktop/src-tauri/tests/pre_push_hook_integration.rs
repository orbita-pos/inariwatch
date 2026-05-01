//! Sesión 20 — pre_push HTTP hook end-to-end with the async runner.
//!
//! POSTs `pre_push` to the hook endpoint with a clean payload (no
//! security findings, no AI key wired → Gate 5 deferred). Verifies:
//!   1. response shape carries `allow` + per-gate `verdicts`.
//!   2. a `gate_runs` audit row was persisted.
//!   3. GateRunStarted + GateRunCompleted events landed on a fresh bus
//!      subscriber.

use std::net::SocketAddr;
use std::sync::Arc;

use inariwatch_desktop_lib::daemon::{start_daemon, DaemonEvent, DaemonHandle};
use inariwatch_desktop_lib::sensors::git::hooks::{router, GitHookState};
use inariwatch_desktop_lib::store::{queries, Store};
use serde_json::{json, Value};

const HOOK_TOKEN: &str = "gh_test_pre_push_int";

async fn boot(addr_port: u16) -> (SocketAddr, Arc<DaemonHandle>, Arc<Store>, tempfile::TempDir, tempfile::TempDir) {
    let _ = addr_port;
    let db_dir   = tempfile::tempdir().unwrap();
    let store    = Arc::new(Store::open_at(&db_dir.path().join("store.db")).unwrap());
    let repo_dir = tempfile::tempdir().unwrap();
    queries::upsert_repo(&store, "repo-int", repo_dir.path().to_str().unwrap(), "int", 0).unwrap();
    let daemon = Arc::new(start_daemon());
    let state  = GitHookState {
        daemon: daemon.clone(),
        store:  store.clone(),
        token:  HOOK_TOKEN.to_string(),
        // No OpenAI client wired → Gate 5 surfaces as `deferred`
        // (see `local_subset::eval_gate_5_*` early-return). Keeps
        // the test deterministic without needing a mock server.
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
async fn pre_push_runs_async_gates_and_persists_audit_row() {
    let (addr, daemon, store, _db, _repo) = boot(0).await;
    let bus_rx = daemon.bus.subscribe();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/sensors/git/event"))
        .header("Authorization", format!("Bearer {HOOK_TOKEN}"))
        .json(&json!({
            "kind":           "pre_push",
            "repo_id":        "repo-int",
            "ref":            "main",
            "sha":            "cafe1234",
            "diff_size":      8_usize,
            "diff_body":      "+ const sum = a + b;\n",
            "commit_message": "feat: add helper",
        }))
        .send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let v: Value = resp.json().await.unwrap();

    // Allowed because: Gate 5 deferred (no OpenAI client), Gate 6
    // deferred (no recording), Gate 9 passes (clean diff). Inline
    // gates 1 + 4 also pass.
    assert_eq!(v.get("allow").and_then(|b| b.as_bool()), Some(true), "{v}");
    let verdicts = v.get("verdicts").and_then(|v| v.as_array()).expect("verdicts array");
    let names: Vec<&str> = verdicts.iter()
        .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
        .collect();
    assert!(names.contains(&"auto_merge_enabled"));
    assert!(names.contains(&"lines_changed"));
    assert!(names.contains(&"self_review"));
    assert!(names.contains(&"substrate_simulate"));
    assert!(names.contains(&"security_scan"));

    // gate_runs row exists.
    let recent = queries::recent_gate_runs(&store, "repo-int", 10).unwrap();
    assert_eq!(recent.len(), 1, "expected one gate_runs row");
    assert_eq!(recent[0].repo_id, "repo-int");
    assert!(recent[0].allowed);
    assert_eq!(recent[0].sha, "cafe1234");

    // Drain the bus and confirm we saw GateRunStarted + GateRunCompleted.
    let mut saw_started   = false;
    let mut saw_completed = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline && (!saw_started || !saw_completed) {
        match tokio::time::timeout(std::time::Duration::from_millis(200), bus_rx.recv_async()).await {
            Ok(Ok(DaemonEvent::GateRunStarted { .. }))   => saw_started   = true,
            Ok(Ok(DaemonEvent::GateRunCompleted { .. })) => saw_completed = true,
            Ok(Ok(_))   => continue,
            Ok(Err(_))  => break,
            Err(_)      => continue,
        }
    }
    assert!(saw_started,   "GateRunStarted never observed");
    assert!(saw_completed, "GateRunCompleted never observed");
}
