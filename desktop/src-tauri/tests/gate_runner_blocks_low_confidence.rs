//! Sesión 20 — gate runner blocks on Gate 5 low confidence.
//!
//! Mock OpenAI returns SCORE: 45 → Gate 5 fails. Diff is clean
//! (no security findings) so Gate 9 passes. Gate 6 deferred. Final
//! verdict: allowed=false with self_review in blocking_gates.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{routing::post, Json, Router};
use inariwatch_desktop_lib::ai::openai::OpenAIClient;
use inariwatch_desktop_lib::daemon::start_daemon;
use inariwatch_desktop_lib::gates::runner::{run_local_subset, GateRunInput};
use inariwatch_desktop_lib::store::queries::upsert_repo;
use inariwatch_desktop_lib::store::Store;
use serde_json::json;

async fn mock_openai_low_score() -> SocketAddr {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|_b: Json<serde_json::Value>| async move {
            Json(json!({
                "id": "x", "object": "chat.completion", "created": 0, "model": "gpt-5.4",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "SCORE: 45\nREASON: risky change to auth flow" },
                    "finish_reason": "stop",
                }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 7, "total_tokens": 17 }
            }))
        }),
    );
    let l    = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

#[tokio::test]
async fn low_self_review_score_blocks_push() {
    let mock = mock_openai_low_score().await;
    let db_dir   = tempfile::tempdir().unwrap();
    let store    = Arc::new(Store::open_at(&db_dir.path().join("store.db")).unwrap());
    let repo_dir = tempfile::tempdir().unwrap();
    upsert_repo(&store, "repo-1", repo_dir.path().to_str().unwrap(), "demo", 0).unwrap();
    let daemon = Arc::new(start_daemon());
    let client = OpenAIClient::with_key("sk-test").with_base_url(format!("http://{mock}"));

    let input = GateRunInput {
        run_id:         "run-low".to_string(),
        repo_id:        "repo-1".to_string(),
        sha:            "abc".to_string(),
        ref_:           "main".to_string(),
        diff_body:      "+ const total = sum(values);".to_string(),
        commit_message: "refactor auth".to_string(),
    };

    let outcome = run_local_subset(&daemon, &store, Some(&client), &input).await;

    assert!(!outcome.allowed, "expected blocked: {outcome:?}");
    assert!(
        outcome.blocking_gates.iter().any(|g| g == "self_review"),
        "blocking: {:?}", outcome.blocking_gates
    );
    let g5 = outcome.individual.iter().find(|v| v.name == "self_review").unwrap();
    assert!(!g5.passed, "g5: {g5:?}");
    let reason = g5.reason.clone().unwrap_or_default();
    assert!(reason.contains("45"), "reason should mention score 45: {reason}");
}
