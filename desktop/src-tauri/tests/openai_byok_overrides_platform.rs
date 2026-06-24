//! Sesión 18 — when both BYOK + `PLATFORM_AI_KEY` are populated the
//! client picks BYOK. Verified by spinning a mock server that asserts
//! the inbound `Authorization: Bearer <key>` matches the BYOK value.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Router,
};
use inariwatch_desktop_lib::ai::openai::OpenAIClient;
use inariwatch_desktop_lib::store::{settings, Store};

const BYOK: &str     = "sk-user-byok-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const PLATFORM: &str = "sk-platform-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

#[derive(Clone)]
struct AssertState {
    saw_byok: Arc<AtomicBool>,
}

async fn assert_handler(
    State(state): State<AssertState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let expected = format!("Bearer {}", BYOK);
    if auth == expected {
        state.saw_byok.store(true, Ordering::SeqCst);
    }
    // Return a minimal completion JSON shape so the chat_complete path
    // is happy. Status 200 even on mismatch — we assert via the flag
    // so the assertion failure message is informative.
    (StatusCode::OK, axum::Json(serde_json::json!({
        "model":   "gpt-4o-mini",
        "choices": [{"message": {"content": "ok"}}],
        "usage":   {"prompt_tokens": 1, "completion_tokens": 1},
    })))
}

async fn boot() -> (SocketAddr, Arc<AtomicBool>) {
    let saw   = Arc::new(AtomicBool::new(false));
    let state = AssertState { saw_byok: saw.clone() };
    let app   = Router::new()
        .route("/v1/chat/completions", post(assert_handler))
        .with_state(state);
    let l     = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr  = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    (addr, saw)
}

#[tokio::test]
async fn byok_takes_precedence_over_platform_key() {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());

    // Both keys present.
    settings::set(&store, "openai_byok_key", BYOK).unwrap();
    std::env::set_var("PLATFORM_AI_KEY", PLATFORM);

    let (addr, saw) = boot().await;

    let client = OpenAIClient::from_store(&store)
        .expect("from_store resolves BYOK")
        .with_base_url(format!("http://{addr}"));

    use inariwatch_desktop_lib::ai::budget::Model;
    use inariwatch_desktop_lib::ai::prompts::ChatMessage;
    let msgs = vec![ChatMessage::user("ping")];
    let _ = client.chat_complete(&msgs, Model::Gpt4oMini).await.expect("complete ok");

    assert!(saw.load(Ordering::SeqCst), "server should have seen the BYOK key, not the platform key");

    std::env::remove_var("PLATFORM_AI_KEY");
}

#[tokio::test]
async fn falls_back_to_platform_when_no_byok() {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());

    // No BYOK in settings; only PLATFORM env.
    std::env::set_var("PLATFORM_AI_KEY", PLATFORM);
    let resolved = OpenAIClient::from_store(&store).expect("platform fallback resolves");
    drop(resolved);
    std::env::remove_var("PLATFORM_AI_KEY");
}

#[tokio::test]
async fn fail_closed_when_no_key_anywhere() {
    let dir   = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_at(&dir.path().join("store.db")).unwrap());

    // Nothing configured. Other tests in the same file may have set
    // PLATFORM_AI_KEY — make sure it's gone.
    std::env::remove_var("PLATFORM_AI_KEY");
    let res = OpenAIClient::from_store(&store);
    assert!(res.is_err(), "should refuse to construct without any key");
}
