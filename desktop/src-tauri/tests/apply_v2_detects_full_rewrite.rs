//! Sesión 26 — Fast Apply v2: when the local model rewrites every line
//! of a substantial original (≥ 10 lines, no shared line content), the
//! validator returns `RepairError::FullRewriteSuspicious`. That's a
//! fatal classifier — even if the rewrite is technically correct, the
//! diff would touch 100% of the file, which is wrong for a targeted
//! "fix this bug" remediation. The loop bails immediately to cloud.
//!
//! Counter-test: when the user instruction explicitly contains
//! "rewrite", the guard is suppressed and the local path proceeds. We
//! split that into a separate test for clarity.

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
    run_single_shot, KORTIX_LOCAL_MODEL_NAME, KORTIX_MODEL_ID, SingleShotInput,
};
use inariwatch_desktop_lib::local_ai::{
    registry::{ModelFamily, ModelSpec},
    LocalAI, ModelRegistry, RuntimeManager, SidecarPaths,
};
use inariwatch_desktop_lib::store::{queries::upsert_repo, settings, Store};
use serde_json::json;

// 12 lines of original — above the FULL_REWRITE_MIN_ORIGINAL_LINES floor.
const ORIGINAL_FILE: &str = "\
let alpha_one = 1;
let alpha_two = 2;
let alpha_three = 3;
let alpha_four = 4;
let alpha_five = 5;
let alpha_six = 6;
let alpha_seven = 7;
let alpha_eight = 8;
let alpha_nine = 9;
let alpha_ten = 10;
let alpha_eleven = 11;
let alpha_twelve = 12;
";

// Every line different from original — triggers FullRewriteSuspicious
// when the instruction has no rewrite keyword.
const REWRITTEN_OUTPUT: &str = "\
const beta_uno = 1;
const beta_dos = 2;
const beta_tres = 3;
const beta_cuatro = 4;
const beta_cinco = 5;
const beta_seis = 6;
const beta_siete = 7;
const beta_ocho = 8;
const beta_nueve = 9;
const beta_diez = 10;
const beta_once = 11;
const beta_doce = 12;
";

const CLOUD_DIFF: &str = "--- a/src/data.rs\n+++ b/src/data.rs\n@@ -1,1 +1,1 @@\n-let alpha_one = 1;\n+let alpha_one = 0;\n";

static KORTIX_CALLS: AtomicU32 = AtomicU32::new(0);

async fn kortix_handler() -> impl axum::response::IntoResponse {
    KORTIX_CALLS.fetch_add(1, Ordering::SeqCst);
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(format!(r#"{{"content":{REWRITTEN_OUTPUT:?},"stop":false}}"#))),
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
        "id":      "chatcmpl-rewrite-fallback",
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

fn open_store(name: &str) -> (Arc<Store>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("store tempdir");
    let store = Arc::new(
        Store::open_at(&dir.path().join(format!("{name}.db"))).expect("open store"),
    );
    (store, dir)
}

fn write_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    std::fs::write(src_dir.join("data.rs"), ORIGINAL_FILE).expect("write data.rs");
    dir
}

fn pre_cache_kortix(models_dir: &std::path::Path) {
    let kortix_dir = models_dir.join(KORTIX_MODEL_ID);
    std::fs::create_dir_all(&kortix_dir).unwrap();
    let cached = kortix_dir.join(format!("{}.gguf", "0".repeat(64)));
    std::fs::write(&cached, b"stub").unwrap();
}

async fn build_local_ai(store: &Arc<Store>, kortix_addr: SocketAddr) -> (LocalAI, tempfile::TempDir) {
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
    (LocalAI::from_parts(registry, runtime), models_tmp)
}

#[tokio::test]
async fn apply_v2_rejects_full_rewrite_when_instruction_lacks_intent() {
    KORTIX_CALLS.store(0, Ordering::SeqCst);

    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store("apply_v2_full_rewrite");
    let repo_dir = write_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-rewrite", repo_path.to_str().unwrap(), "demo", 0).unwrap();
    settings::set(&store, "local_ai_tier", "tier2").unwrap();

    let (local_ai, _models_tmp) = build_local_ai(&store, kortix_addr).await;

    let cloud_client = OpenAIClient::with_key("sk-test")
        .with_base_url(format!("http://{cloud_addr}"));

    let input = SingleShotInput {
        repo_id:           "repo-rewrite".to_string(),
        repo_path,
        // No "rewrite" / "redo" / "from scratch" in the instruction —
        // the FullRewriteSuspicious guard MUST fire.
        error_message:     "fix the off-by-one bug in alpha_one".to_string(),
        stack_trace:       Some("at src/data.rs:1".to_string()),
        error_fingerprint: Some("fp-rewrite-1".to_string()),
        file_hint:         Some("src/data.rs".to_string()),
    };

    let draft = run_single_shot(
        &store, &cloud_client, Some(&local_ai), true, "session-rewrite-1", &input,
    )
    .await
    .expect("single-shot returns cloud draft after full-rewrite escalation");

    assert_eq!(draft.model_used, "gpt-5.4", "must escalate to cloud after full-rewrite");
    assert!(draft.cents > 0);

    // Fatal classifier — exactly one local call, no retry.
    assert_eq!(
        KORTIX_CALLS.load(Ordering::SeqCst), 1,
        "FullRewriteSuspicious is fatal: must NOT retry locally",
    );
}

#[tokio::test]
async fn apply_v2_allows_full_rewrite_when_instruction_says_rewrite() {
    KORTIX_CALLS.store(0, Ordering::SeqCst);

    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store("apply_v2_full_rewrite_intent");
    let repo_dir = write_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-rewrite-ok", repo_path.to_str().unwrap(), "demo", 0).unwrap();
    settings::set(&store, "local_ai_tier", "tier2").unwrap();

    let (local_ai, _models_tmp) = build_local_ai(&store, kortix_addr).await;

    let cloud_client = OpenAIClient::with_key("sk-test")
        .with_base_url(format!("http://{cloud_addr}"));

    let input = SingleShotInput {
        repo_id:           "repo-rewrite-ok".to_string(),
        repo_path,
        // "rewrite" → guard suppressed → local path proceeds.
        error_message:     "Please rewrite this file using const instead of let".to_string(),
        stack_trace:       None,
        error_fingerprint: Some("fp-rewrite-ok-1".to_string()),
        file_hint:         Some("src/data.rs".to_string()),
    };

    let draft = run_single_shot(
        &store, &cloud_client, Some(&local_ai), true, "session-rewrite-ok-1", &input,
    )
    .await
    .expect("single-shot returns local kortix draft when rewrite intent is explicit");

    assert_eq!(
        draft.model_used, KORTIX_LOCAL_MODEL_NAME,
        "rewrite intent should bypass guard and serve from local",
    );
    assert_eq!(draft.cents, 0);
}
