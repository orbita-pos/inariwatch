//! Sesión 25 — Fast Apply local path: when the Kortix model is NOT
//! cached on disk (e.g. user hasn't downloaded it yet), the pipeline
//! falls back to the existing gpt-5.4 cloud single-shot path with no
//! caller-visible difference.
//!
//! This is one of the "any prerequisite missing → cloud" branches the
//! spec enumerates. We test it because it's the most common
//! first-run shape: the user toggles `local_apply_enabled = true`
//! before downloading the GGUF.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{routing::post, Json, Router};
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

const CLOUD_DIFF: &str = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,3 +1,3 @@\n-fn off_by_one() -> usize { 1 }\n+fn off_by_one() -> usize { 0 }\n fn main() {}\n";

async fn cloud_handler(_body: Json<serde_json::Value>) -> Json<serde_json::Value> {
    let content = format!("```diff\n{}```", CLOUD_DIFF);
    Json(json!({
        "id":      "chatcmpl-fallback",
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
        Store::open_at(&dir.path().join("fast_apply_fallback.db")).expect("open store"),
    );
    (store, dir)
}

fn write_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    std::fs::write(
        src_dir.join("main.rs"),
        "fn off_by_one() -> usize { 1 }\nfn main() {}\n",
    )
    .expect("write main.rs");
    dir
}

#[tokio::test]
async fn missing_cached_model_falls_back_to_cloud() {
    let cloud_addr = boot_cloud_mock().await;
    let (store, _store_tmp) = open_store();
    let repo_dir = write_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-fallback", repo_path.to_str().unwrap(), "demo", 0).unwrap();

    // Tier IS Tier2 in settings, toggle IS enabled — but we deliberately
    // do NOT pre-create the cached GGUF. `is_cached` returns false →
    // the local branch short-circuits and the cloud path runs.
    settings::set(&store, "local_ai_tier", "tier2").unwrap();

    let kortix_spec = ModelSpec {
        id:           KORTIX_MODEL_ID.into(),
        display_name: "Kortix FastApply 7B (Apply)".into(),
        blake3_hex:   "0".repeat(64),
        size_bytes:   1,
        family:       ModelFamily::Apply,
    };

    let models_tmp = tempfile::tempdir().unwrap();
    // NO pre_cache_kortix call here — that's the whole point of the test.

    let registry = ModelRegistry::new_with_paths(
        store.clone(),
        models_tmp.path().to_path_buf(),
        vec![kortix_spec],
        "http://127.0.0.1:1".to_string(),
    )
    .unwrap();

    let runtime = RuntimeManager::new(SidecarPaths::default());
    let local_ai = LocalAI::from_parts(registry, runtime);

    let cloud_client = OpenAIClient::with_key("sk-test")
        .with_base_url(format!("http://{cloud_addr}"));

    let input = SingleShotInput {
        repo_id:           "repo-fallback".to_string(),
        repo_path,
        error_message:     "off_by_one returns wrong value".to_string(),
        stack_trace:       Some("at src/main.rs:1".to_string()),
        error_fingerprint: Some("fp-fallback-1".to_string()),
        file_hint:         Some("src/main.rs".to_string()),
    };

    let draft = run_single_shot(
        &store,
        &cloud_client,
        Some(&local_ai),
        /* local_apply_enabled */ true,
        "session-fallback-1",
        &input,
    )
    .await
    .expect("single-shot");

    // Cloud path was taken — model is the gpt-5.4 wire name from
    // `Model::api_name`, prompt/completion tokens are populated, cents
    // are nonzero. The KORTIX_LOCAL_MODEL_NAME would be "kortix-7b-local"
    // — the assertion below pins the *cloud* shape.
    assert_eq!(
        draft.model_used, "gpt-5.4",
        "fallback should produce the cloud model name, got {:?}",
        draft.model_used
    );
    assert_eq!(draft.prompt_tokens, 500);
    assert_eq!(draft.completion_tokens, 80);
    assert!(draft.cents > 0, "cloud path must record nonzero cents; got {}", draft.cents);

    assert!(draft.diff_unified.contains("+fn off_by_one() -> usize { 0 }"));
    assert_eq!(draft.files_touched, vec!["src/main.rs".to_string()]);
}
