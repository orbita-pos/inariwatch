//! Sesión 26 — Fast Apply v2: when BOTH local attempts fail with a
//! recoverable validator error, the loop falls back to cloud. Verified
//! by: kortix mock returns the same broken output (mid-stream ChatML
//! marker) on every call. Cloud mock returns a clean diff. Caller sees
//! `model_used == "gpt-5.4"` AND the kortix mock was called exactly
//! twice (attempt 1 + 1 retry, then cloud).

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

const ORIGINAL_FILE: &str = "\
fn off_by_one() -> usize { 1 }
fn another() -> usize { 2 }
fn third() -> usize { 3 }
fn main() {}
";

// Always-broken kortix output — mid-stream ChatML marker. Each retry
// returns the same body, so the loop exhausts MAX_LOCAL_ATTEMPTS and
// escalates to cloud.
const BROKEN_OUTPUT: &str = "\
fn off_by_one() -> usize { 0 }
<|im_end|>
fn another() -> usize { 2 }
fn third() -> usize { 3 }
fn main() {}
// padding line one to push the mid-content marker outside the trailing 16 bytes
// padding line two so the validator's body-slice contains the marker
";

const CLOUD_DIFF: &str = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,4 +1,4 @@\n-fn off_by_one() -> usize { 1 }\n+fn off_by_one() -> usize { 0 }\n fn another() -> usize { 2 }\n fn third() -> usize { 3 }\n fn main() {}\n";

static KORTIX_CALLS: AtomicU32 = AtomicU32::new(0);

async fn kortix_handler() -> impl axum::response::IntoResponse {
    KORTIX_CALLS.fetch_add(1, Ordering::SeqCst);
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(format!(r#"{{"content":{BROKEN_OUTPUT:?},"stop":false}}"#))),
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
        "id":      "chatcmpl-2-retries-fallback",
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
        Store::open_at(&dir.path().join("apply_v2_exhausted.db")).expect("open store"),
    );
    (store, dir)
}

fn write_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    std::fs::write(src_dir.join("main.rs"), ORIGINAL_FILE).expect("write main.rs");
    dir
}

fn pre_cache_kortix(models_dir: &std::path::Path) {
    let kortix_dir = models_dir.join(KORTIX_MODEL_ID);
    std::fs::create_dir_all(&kortix_dir).unwrap();
    let cached = kortix_dir.join(format!("{}.gguf", "0".repeat(64)));
    std::fs::write(&cached, b"stub").unwrap();
}

#[tokio::test]
async fn apply_v2_falls_back_to_cloud_after_two_failed_local_attempts() {
    KORTIX_CALLS.store(0, Ordering::SeqCst);

    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store();
    let repo_dir = write_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-exhausted", repo_path.to_str().unwrap(), "demo", 0).unwrap();
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
        repo_id:           "repo-exhausted".to_string(),
        repo_path,
        error_message:     "off_by_one returns wrong value".to_string(),
        stack_trace:       Some("at src/main.rs:1".to_string()),
        error_fingerprint: Some("fp-exhausted-1".to_string()),
        file_hint:         Some("src/main.rs".to_string()),
    };

    let draft = run_single_shot(
        &store, &cloud_client, Some(&local_ai), true, "session-exhausted-1", &input,
    )
    .await
    .expect("single-shot returns cloud draft after exhausting local retries");

    // Cloud path served the request after both local attempts failed.
    assert_eq!(draft.model_used, "gpt-5.4");
    assert_eq!(draft.prompt_tokens, 500);
    assert!(draft.cents > 0);
    assert!(draft.diff_unified.contains("+fn off_by_one() -> usize { 0 }"));

    // Critical: the kortix mock was called EXACTLY twice. Once for the
    // initial attempt, once for the repair-prompt retry. Three+ calls
    // would mean MAX_LOCAL_ATTEMPTS drifted; one call would mean the
    // recoverable error was misclassified as fatal.
    assert_eq!(
        KORTIX_CALLS.load(Ordering::SeqCst), 2,
        "kortix mock must have been called exactly twice before cloud fallback; got {}",
        KORTIX_CALLS.load(Ordering::SeqCst),
    );
}
