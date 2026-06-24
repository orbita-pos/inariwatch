//! Sesión 20 — gate runner happy path.
//!
//! Mock OpenAI returns SCORE: 85 → Gate 5 passes. No substrate
//! recording on disk → Gate 6 deferred (default-allow). Diff has no
//! security patterns → Gate 9 passes. Final verdict: allowed=true,
//! all 3 gates non-blocking.

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

async fn mock_openai_score(score: u32, reason: &'static str) -> SocketAddr {
    let body = format!("SCORE: {score}\nREASON: {reason}");
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |_b: Json<serde_json::Value>| {
            let body = body.clone();
            async move {
                Json(json!({
                    "id": "chatcmpl-t",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "gpt-5.4",
                    "choices": [{
                        "index": 0,
                        "message": { "role": "assistant", "content": body },
                        "finish_reason": "stop",
                    }],
                    "usage": { "prompt_tokens": 50, "completion_tokens": 12, "total_tokens": 62 }
                }))
            }
        }),
    );
    let l    = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

fn open_store() -> (Arc<Store>, tempfile::TempDir, tempfile::TempDir) {
    let db_dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&db_dir.path().join("store.db")).unwrap());
    let repo_dir = tempfile::tempdir().unwrap();
    upsert_repo(&store, "repo-1", repo_dir.path().to_str().unwrap(), "demo", 0).unwrap();
    (store, db_dir, repo_dir)
}

#[tokio::test]
async fn clean_diff_with_passing_self_review_is_allowed() {
    let mock = mock_openai_score(85, "clean refactor").await;
    let (store, _db_dir, _repo_dir) = open_store();
    let daemon = Arc::new(start_daemon());
    let client = OpenAIClient::with_key("sk-test").with_base_url(format!("http://{mock}"));

    let input = GateRunInput {
        run_id:         "run-clean".to_string(),
        repo_id:        "repo-1".to_string(),
        sha:            "abc".to_string(),
        ref_:           "main".to_string(),
        diff_body:      "+ const sum = a + b;\n+ const product = a * b;\n".to_string(),
        commit_message: "feat: add helpers".to_string(),
    };

    let outcome = run_local_subset(&daemon, &store, Some(&client), &input).await;

    assert!(outcome.allowed, "expected allowed: {outcome:?}");
    assert!(outcome.blocking_gates.is_empty(), "blocking: {:?}", outcome.blocking_gates);
    assert_eq!(outcome.individual.len(), 3, "expected 3 verdicts");

    // Gate 5 PASS, Gate 6 DEFERRED (no recording dir), Gate 9 PASS.
    let g5 = outcome.individual.iter().find(|v| v.name == "self_review").unwrap();
    assert!(g5.passed && !g5.deferred, "g5: {g5:?}");

    let g6 = outcome.individual.iter().find(|v| v.name == "substrate_simulate").unwrap();
    assert!(g6.passed && g6.deferred, "g6 should be deferred: {g6:?}");

    let g9 = outcome.individual.iter().find(|v| v.name == "security_scan").unwrap();
    assert!(g9.passed && !g9.deferred, "g9: {g9:?}");
}
