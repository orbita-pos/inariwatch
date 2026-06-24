//! Sesión 18 — `OpenAIClient` retries on 429 / 5xx with exponential
//! backoff. Variants:
//! - 429 twice → 200 on attempt 3 → success.
//! - 4xx (non-429) → fails immediately, no retry.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Router,
};
use inariwatch_desktop_lib::ai::budget::Model;
use inariwatch_desktop_lib::ai::openai::{OpenAIClient, OpenAIError};
use inariwatch_desktop_lib::ai::prompts::ChatMessage;

#[derive(Clone)]
struct CountingState {
    counter:    Arc<AtomicU32>,
    fail_count: u32,
    fail_code:  StatusCode,
}

async fn flaky_handler(State(state): State<CountingState>) -> impl IntoResponse {
    let n = state.counter.fetch_add(1, Ordering::SeqCst);
    if n < state.fail_count {
        let body = r#"{"error":"transient"}"#;
        return (state.fail_code, body).into_response();
    }
    (StatusCode::OK, axum::Json(serde_json::json!({
        "model":   "gpt-4o-mini",
        "choices": [{"message": {"content": "ok"}}],
        "usage":   {"prompt_tokens": 1, "completion_tokens": 1},
    }))).into_response()
}

async fn boot(fail_count: u32, fail_code: StatusCode) -> (SocketAddr, Arc<AtomicU32>) {
    let counter = Arc::new(AtomicU32::new(0));
    let state   = CountingState { counter: counter.clone(), fail_count, fail_code };
    let app     = Router::new()
        .route("/v1/chat/completions", post(flaky_handler))
        .with_state(state);
    let l       = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr    = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    (addr, counter)
}

#[tokio::test]
async fn retries_on_429_then_succeeds() {
    let (addr, counter) = boot(2, StatusCode::TOO_MANY_REQUESTS).await;
    let client = OpenAIClient::with_key("sk-test").with_base_url(format!("http://{addr}"));

    let started = Instant::now();
    let msgs = vec![ChatMessage::user("ping")];
    let resp = client.chat_complete(&msgs, Model::Gpt4oMini).await.expect("third try succeeds");
    let elapsed = started.elapsed();

    assert_eq!(counter.load(Ordering::SeqCst), 3, "exactly 3 attempts (2 fail + 1 success)");
    assert_eq!(resp.content, "ok");
    // 1s + 2s = 3s of backoff, plus a little overhead. Don't assert
    // an upper bound (CI / sandboxed schedulers vary), but >= 2.5s
    // proves we actually slept between attempts.
    assert!(elapsed >= Duration::from_millis(2500), "elapsed {:?} should reflect 1s+2s backoff", elapsed);
}

#[tokio::test]
async fn no_retry_on_400_bad_request() {
    let (addr, counter) = boot(99, StatusCode::BAD_REQUEST).await;
    let client = OpenAIClient::with_key("sk-test").with_base_url(format!("http://{addr}"));

    let msgs = vec![ChatMessage::user("ping")];
    let res  = client.chat_complete(&msgs, Model::Gpt4oMini).await;
    let err  = res.expect_err("400 bubbles up immediately");
    assert!(matches!(err, OpenAIError::Api { status: 400, .. }), "got {:?}", err);
    assert_eq!(counter.load(Ordering::SeqCst), 1, "no retry on 4xx");
}
