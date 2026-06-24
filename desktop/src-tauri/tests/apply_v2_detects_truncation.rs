//! Sesión 26 — Fast Apply v2: when the local model produces output
//! much shorter than the original (typical signature of a truncated
//! stream — context length hit, network drop mid-stream, prompt
//! exhausted), `diff_repair::validate_and_repair` returns
//! `RepairError::Truncated`. That's a fatal classifier — the loop bails
//! IMMEDIATELY to cloud, no retry.
//!
//! Verified by: kortix mock returns ~10% of original size → cloud mock
//! receives the request and produces a gpt-5.4 diff. Caller sees
//! `model_used == "gpt-5.4"`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use axum::{
    response::{sse::Event, Sse},
    routing::post,
    Json, Router,
};
use inariwatch_desktop_lib::ai::openai::OpenAIClient;
use inariwatch_desktop_lib::ai::remediate::single_shot::{
    run_single_shot, KORTIX_MODEL_ID, SingleShotInput,
};
use inariwatch_desktop_lib::local_ai::{
    registry::{ModelFamily, ModelSpec},
    LocalAI, ModelRegistry, RuntimeManager, SidecarPaths,
};
use inariwatch_desktop_lib::store::{queries::upsert_repo, settings, Store};
use serde_json::json;

// ~600 bytes of original — well above the 200-byte truncation floor.
const ORIGINAL_FILE: &str = "\
fn alpha() -> usize { 1 }
fn beta() -> usize { 2 }
fn gamma() -> usize { 3 }
fn delta() -> usize { 4 }
fn epsilon() -> usize { 5 }
fn zeta() -> usize { 6 }
fn eta() -> usize { 7 }
fn theta() -> usize { 8 }
fn iota() -> usize { 9 }
fn kappa() -> usize { 10 }
fn lambda() -> usize { 11 }
fn mu() -> usize { 12 }
fn nu() -> usize { 13 }
fn xi() -> usize { 14 }
fn omicron() -> usize { 15 }
fn pi() -> usize { 16 }
fn main() {}
";

// Mock returns ~50 bytes — under TRUNCATION_RATIO (0.5) of original.
// Triggers the Truncated classifier → fatal → cloud fallback.
const TRUNCATED_OUTPUT: &str = "fn alpha() -> usize { 0 }\nfn main() {}\n";

// Cloud returns a clean diff (we never assert on its content beyond
// "model_used is gpt-5.4 and the diff is non-empty").
const CLOUD_DIFF: &str = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,1 +1,1 @@\n-fn alpha() -> usize { 1 }\n+fn alpha() -> usize { 0 }\n";

static KORTIX_CALLS: AtomicU32 = AtomicU32::new(0);

async fn kortix_handler() -> impl axum::response::IntoResponse {
    KORTIX_CALLS.fetch_add(1, Ordering::SeqCst);
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(format!(r#"{{"content":{TRUNCATED_OUTPUT:?},"stop":false}}"#))),
        Ok(Event::default().data(r#"{"content":"","stop":true,"stop_type":"length"}"#)),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot_kortix_mock() -> SocketAddr {
    let app = Router::new().route("/completion", post(kortix_handler));
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

async fn cloud_handler(_body: Json<serde_json::Value>) -> Json<serde_json::Value> {
    let content = format!("```diff\n{}```", CLOUD_DIFF);
    Json(json!({
        "id":      "chatcmpl-trunc-fallback",
        "object":  "chat.completion",
        "created": 0,
        "model":   "gpt-5.4",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens":     500,
            "completion_tokens": 80,
            "total_tokens":      580,
        }
    }))
}

async fn boot_cloud_mock() -> SocketAddr {
    let app = Router::new().route("/v1/chat/completions", post(cloud_handler));
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

fn open_store() -> (Arc<Store>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("store tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join("apply_v2_truncation.db")).expect("open store"),
    );
    (store, dir)
}

fn write_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    std::fs::write(src_dir.join("lib.rs"), ORIGINAL_FILE).expect("write lib.rs");
    dir
}

fn pre_cache_kortix(models_dir: &std::path::Path) {
    let kortix_dir = models_dir.join(KORTIX_MODEL_ID);
    std::fs::create_dir_all(&kortix_dir).unwrap();
    let cached = kortix_dir.join(format!("{}.gguf", "0".repeat(64)));
    std::fs::write(&cached, b"stub").unwrap();
}

#[tokio::test]
async fn apply_v2_detects_truncation_and_escalates_to_cloud_without_retry() {
    KORTIX_CALLS.store(0, Ordering::SeqCst);

    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store();
    let repo_dir = write_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-trunc", repo_path.to_str().unwrap(), "demo", 0).unwrap();
    settings::set(&store, "local_ai_tier", "tier2").unwrap();

    let kortix_spec = ModelSpec {
        id:           KORTIX_MODEL_ID.into(),
        display_name: "Kortix FastApply 7B (Apply)".into(),
        blake3_hex:   "0".repeat(64),
        size_bytes:   1,
        family:       ModelFamily::Apply,
    };
    let models_tmp = tempfile::tempdir().unwrap();
    pre_cache_kortix(models_tmp.path());
    let registry = ModelRegistry::new_with_paths(
        store.clone(),
        models_tmp.path().to_path_buf(),
        vec![kortix_spec],
        "http://127.0.0.1:1".to_string(),
    )
    .unwrap();

    let runtime = RuntimeManager::new(SidecarPaths::default());
    runtime
        .register_external_endpoint(KORTIX_MODEL_ID, format!("http://{kortix_addr}"))
        .await;
    let local_ai = LocalAI::from_parts(registry, runtime);

    let cloud_client = OpenAIClient::with_key("sk-test")
        .with_base_url(format!("http://{cloud_addr}"));

    let input = SingleShotInput {
        repo_id:           "repo-trunc".to_string(),
        repo_path,
        error_message:     "alpha returns wrong value".to_string(),
        stack_trace:       Some("at src/lib.rs:1".to_string()),
        error_fingerprint: Some("fp-trunc-1".to_string()),
        file_hint:         Some("src/lib.rs".to_string()),
    };

    let draft = run_single_shot(
        &store, &cloud_client, Some(&local_ai), true, "session-trunc-1", &input,
    )
    .await
    .expect("single-shot returns cloud draft after truncation escalation");

    // Cloud path served the request — no local model_used.
    assert_eq!(draft.model_used, "gpt-5.4");
    assert_eq!(draft.prompt_tokens, 500);
    assert!(draft.cents > 0, "cloud path should record nonzero cents");

    // Critical: kortix was called EXACTLY ONCE. Truncation is fatal —
    // the loop must NOT retry locally, otherwise we burn an extra
    // 180-second timeout window before the user gets a cloud response.
    assert_eq!(
        KORTIX_CALLS.load(Ordering::SeqCst), 1,
        "fatal validator errors (Truncated) must skip the retry attempt; \
         got {} calls",
        KORTIX_CALLS.load(Ordering::SeqCst),
    );
}
