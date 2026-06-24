//! Sesión 26 — Fast Apply v2: when the local model emits a recoverable
//! validator error on attempt 1 (e.g. a partial `<|im_end|>` token in
//! the body), the loop builds a `build_kortix_repair_prompt` and retries
//! locally. If attempt 2 succeeds, the user gets a local draft — no
//! cloud call, no extra cost.
//!
//! Verified by: stateful kortix mock returns BAD output (mid-stream
//! ChatML marker) on call 1, GOOD output on call 2. The cloud mock
//! panics if hit. Caller sees `model_used == "kortix-7b-local"` AND
//! the kortix mock was called exactly twice.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
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

const ORIGINAL_FILE: &str = "\
fn off_by_one() -> usize { 1 }
fn another() -> usize { 2 }
fn third() -> usize { 3 }
fn main() {}
";

const FIXED_FILE: &str = "\
fn off_by_one() -> usize { 0 }
fn another() -> usize { 2 }
fn third() -> usize { 3 }
fn main() {}
";

// Attempt 1 output: same content as FIXED_FILE but with a partial
// ChatML token spliced into the body, well outside the trailing 16-byte
// window the S25 `strip_chatml_trailer` checks. Triggers
// `RepairError::PartialChatMLEmission` → recoverable → retry.
const BROKEN_OUTPUT_ATTEMPT_1: &str = "\
fn off_by_one() -> usize { 0 }
<|im_end|>
fn another() -> usize { 2 }
fn third() -> usize { 3 }
fn main() {}
// padding line one to push the mid-content marker outside the trailing 16 bytes
// padding line two so the validator's body-slice contains the marker
";

static KORTIX_CALLS: AtomicU32 = AtomicU32::new(0);

async fn kortix_handler() -> impl axum::response::IntoResponse {
    let n = KORTIX_CALLS.fetch_add(1, Ordering::SeqCst) + 1;
    let payload = if n == 1 { BROKEN_OUTPUT_ATTEMPT_1 } else { FIXED_FILE };
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(format!(r#"{{"content":{payload:?},"stop":false}}"#))),
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
    panic!("cloud OpenAI was called — local Kortix retry should have served the request");
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
        Store::open_at(&dir.path().join("apply_v2_retry.db")).expect("open store"),
    );
    (store, dir)
}

fn write_git_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    std::fs::write(src_dir.join("main.rs"), ORIGINAL_FILE).expect("write main.rs");

    let _ = Command::new("git").current_dir(dir.path()).args(["init", "-q"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "user.email", "test@inari.local"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "user.name", "Inari Test"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["add", "-A"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["commit", "-q", "-m", "init"]).output();
    dir
}

fn pre_cache_kortix(models_dir: &std::path::Path) {
    let kortix_dir = models_dir.join(KORTIX_MODEL_ID);
    std::fs::create_dir_all(&kortix_dir).unwrap();
    let cached = kortix_dir.join(format!("{}.gguf", "0".repeat(64)));
    std::fs::write(&cached, b"stub").unwrap();
}

#[tokio::test]
async fn apply_v2_retries_on_parse_fail_and_serves_local_on_attempt_2() {
    KORTIX_CALLS.store(0, Ordering::SeqCst);

    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store();
    let repo_dir = write_git_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-retry", repo_path.to_str().unwrap(), "demo", 0).unwrap();
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
        repo_id:           "repo-retry".to_string(),
        repo_path:         repo_path.clone(),
        error_message:     "off_by_one returns wrong value".to_string(),
        stack_trace:       Some("at src/main.rs:1".to_string()),
        error_fingerprint: Some("fp-retry-1".to_string()),
        file_hint:         Some("src/main.rs".to_string()),
    };

    let draft = run_single_shot(
        &store, &cloud_client, Some(&local_ai), true, "session-retry-1", &input,
    )
    .await
    .expect("single-shot returns local kortix draft on attempt 2");

    assert_eq!(
        draft.model_used, KORTIX_LOCAL_MODEL_NAME,
        "successful retry must still produce a local-mode draft (cheaper, faster)",
    );
    assert_eq!(draft.cents, 0);
    assert_eq!(
        KORTIX_CALLS.load(Ordering::SeqCst), 2,
        "kortix mock must have been called exactly twice (attempt 1 + retry)",
    );

    // The diff that survived attempt 2 must apply cleanly against the
    // working tree.
    let mut patch = std::env::temp_dir();
    patch.push(format!("inari-apply-v2-retry-{}.patch", uuid::Uuid::new_v4()));
    std::fs::write(&patch, &draft.diff_unified).unwrap();
    let check = Command::new("git")
        .current_dir(&repo_path)
        .args(["apply", "--check", patch.to_str().unwrap()])
        .output()
        .expect("git apply --check spawns");
    let _ = std::fs::remove_file(&patch);
    assert!(
        check.status.success(),
        "retried diff must apply clean:\nstderr: {}\ndiff:\n{}",
        String::from_utf8_lossy(&check.stderr),
        draft.diff_unified,
    );
}
