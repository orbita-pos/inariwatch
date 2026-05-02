//! Sesión 26 — Fast Apply v2: model returns the edited file with LF
//! line endings, but the on-disk source is CRLF. The diff_repair
//! validator's `align_to_original` swaps LF → CRLF so the resulting
//! unified diff applies cleanly via `git apply --check`. Without this
//! repair, the diff would be rejected because the context bytes don't
//! match the working tree byte-for-byte.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
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

// On-disk source uses CRLF line endings (typical Windows checkout).
const ORIGINAL_FILE: &str = "fn off_by_one() -> usize { 1 }\r\nfn main() {}\r\n";
// Model returns the edited file with LF endings (typical Kortix output).
const MODEL_OUTPUT_LF: &str = "fn off_by_one() -> usize { 0 }\nfn main() {}\n";

async fn kortix_handler() -> impl axum::response::IntoResponse {
    let part1 = "fn off_by_one() -> usize { 0 }\n";
    let part2 = "fn main() {}\n";
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(format!(r#"{{"content":{part1:?},"stop":false}}"#))),
        Ok(Event::default().data(format!(r#"{{"content":{part2:?},"stop":false}}"#))),
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
    panic!("cloud OpenAI was called — local Kortix path with CRLF repair should have served the request");
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
        Store::open_at(&dir.path().join("apply_v2_crlf.db")).expect("open store"),
    );
    (store, dir)
}

fn write_crlf_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    // Write the CRLF bytes EXPLICITLY — don't rely on text-mode write
    // which would translate on platforms with newline-mangling APIs.
    std::fs::write(src_dir.join("main.rs"), ORIGINAL_FILE.as_bytes()).expect("write main.rs");

    // Configure git to NOT auto-translate line endings — we need the
    // repo to keep the bytes we wrote, otherwise the apply check
    // wouldn't reproduce the CRLF drift the test exercises.
    let _ = Command::new("git").current_dir(dir.path()).args(["init", "-q"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "core.autocrlf", "false"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "core.eol", "crlf"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "user.email", "test@inari.local"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "user.name", "Inari Test"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["add", "-A"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["commit", "-q", "-m", "init"]).output();

    dir
}

fn pre_cache_kortix(models_dir: &std::path::Path) {
    let kortix_dir = models_dir.join(KORTIX_MODEL_ID);
    std::fs::create_dir_all(&kortix_dir).expect("mkdir kortix");
    let cached = kortix_dir.join(format!("{}.gguf", "0".repeat(64)));
    std::fs::write(&cached, b"stub").expect("write stub gguf");
}

#[tokio::test]
async fn apply_v2_normalises_crlf_drift_and_serves_local() {
    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store();
    let repo_dir = write_crlf_repo();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();
    upsert_repo(&store, "repo-crlf", repo_path.to_str().unwrap(), "demo", 0).unwrap();
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
        repo_id:           "repo-crlf".to_string(),
        repo_path:         repo_path.clone(),
        error_message:     "off_by_one returns wrong value".to_string(),
        stack_trace:       Some("at src/main.rs:1".to_string()),
        error_fingerprint: Some("fp-crlf-1".to_string()),
        file_hint:         Some("src/main.rs".to_string()),
    };

    let draft = run_single_shot(
        &store, &cloud_client, Some(&local_ai), true, "session-crlf-1", &input,
    )
    .await
    .expect("local kortix path serves CRLF-repaired draft");

    // Sanity: the model returned LF, but the validator should have
    // re-aligned the edited body to CRLF before diffing — proves by the
    // local model_used + the diff applying clean below.
    assert_eq!(draft.model_used, KORTIX_LOCAL_MODEL_NAME);
    assert_eq!(draft.cents, 0);
    assert_eq!(draft.files_touched, vec!["src/main.rs".to_string()]);

    // The headline assertion: the diff applies cleanly against the
    // CRLF on-disk file. Without `align_to_original`'s LF→CRLF swap,
    // git would reject the patch with "patch does not apply" because
    // the context lines wouldn't match byte-for-byte.
    let mut patch = std::env::temp_dir();
    patch.push(format!("inari-apply-v2-crlf-{}.patch", uuid::Uuid::new_v4()));
    std::fs::write(&patch, &draft.diff_unified).unwrap();
    let check = Command::new("git")
        .current_dir(&repo_path)
        .args(["apply", "--check", patch.to_str().unwrap()])
        .output()
        .expect("git apply --check spawns");
    let _ = std::fs::remove_file(&patch);
    assert!(
        check.status.success(),
        "git apply --check rejected the CRLF-repaired diff:\nstderr: {}\ndiff:\n{:?}\nmodel_output_lf:{:?}",
        String::from_utf8_lossy(&check.stderr),
        draft.diff_unified,
        MODEL_OUTPUT_LF,
    );
}
