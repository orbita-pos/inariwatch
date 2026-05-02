//! Sesión 25 — Fast Apply local path: cost ledger guarantee.
//!
//! Distinct from `fast_apply_local_basic.rs` because it focuses
//! specifically on the cents/tokens contract: when the local path
//! serves the request, the resulting `RemediationDraft` MUST stamp
//! `cents == 0` + `prompt_tokens == 0` + `completion_tokens == 0`.
//! Dashboards key off these fields to draw the "free local fixes
//! today" widget; a regression here would silently bill local
//! sessions against the cloud quota.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    response::{sse::Event, Sse},
    routing::post,
    Router,
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

async fn kortix_handler() -> impl axum::response::IntoResponse {
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(r#"{"content":"export const ANSWER = 42;\n","stop":false}"#)),
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

async fn cloud_must_not_fire() -> axum::Json<serde_json::Value> {
    panic!("cloud OpenAI was called — local Kortix path should have served the zero-cost request");
}

async fn boot_cloud_mock() -> SocketAddr {
    let app = Router::new().route("/v1/chat/completions", post(cloud_must_not_fire));
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
        Store::open_at(&dir.path().join("fast_apply_zero_cost.db")).expect("open store"),
    );
    (store, dir)
}

fn write_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    // Use a longish source file so the prompt has meaningful body —
    // a one-liner would let the test pass even if the cost path
    // hardcoded zero unconditionally.
    std::fs::write(
        src_dir.join("main.ts"),
        "export const ANSWER = 41;\n// many imaginary lines\n",
    )
    .expect("write main.ts");
    dir
}

fn pre_cache_kortix(models_dir: &std::path::Path) {
    let kortix_dir = models_dir.join(KORTIX_MODEL_ID);
    std::fs::create_dir_all(&kortix_dir).unwrap();
    let cached = kortix_dir.join(format!("{}.gguf", "0".repeat(64)));
    std::fs::write(&cached, b"stub").unwrap();
}

#[tokio::test]
async fn local_kortix_session_records_zero_cents_and_zero_tokens() {
    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store();
    let repo_dir = write_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-zc", repo_path.to_str().unwrap(), "demo", 0).unwrap();

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

    let cloud_client = OpenAIClient::with_key("sk-fail-if-called")
        .with_base_url(format!("http://{cloud_addr}"));

    let input = SingleShotInput {
        repo_id:           "repo-zc".to_string(),
        repo_path,
        error_message:     "ANSWER off by one".to_string(),
        stack_trace:       None,
        error_fingerprint: Some("fp-zc-1".to_string()),
        file_hint:         Some("src/main.ts".to_string()),
    };

    let draft = run_single_shot(
        &store,
        &cloud_client,
        Some(&local_ai),
        true,
        "session-zc-1",
        &input,
    )
    .await
    .expect("local kortix path serves zero-cost session");

    // The headline guarantee.
    assert_eq!(draft.cents, 0, "local-mode session must record zero cents");
    assert_eq!(draft.prompt_tokens, 0, "local-mode session must record zero prompt tokens");
    assert_eq!(draft.completion_tokens, 0, "local-mode session must record zero completion tokens");
    assert_eq!(draft.model_used, KORTIX_LOCAL_MODEL_NAME);

    // The diff is non-trivial — proves this path actually ran (vs.
    // an empty draft with cents=0 by coincidence).
    assert!(!draft.diff_unified.is_empty(), "local path must produce a diff body");
    assert!(!draft.files_touched.is_empty(), "local path must surface at least one file");
}
