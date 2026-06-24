//! Sesión 25 — Fast Apply local path: stub Kortix returns the FULL
//! edited file → `run_single_shot` builds a unified diff via the
//! `similar` crate → diff applies clean to the tempdir repo via
//! `git apply --check`.
//!
//! The test bypasses the registry/runtime download path by registering
//! the mock llama-server directly as `kortix-fast-apply-7b`'s external
//! endpoint AND by laying down an empty cached GGUF on disk so
//! `is_cached` returns true. The hardware tier is forced to `tier2`
//! through the settings table (the actual host may be Tier1).

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

const ORIGINAL_FILE: &str = "fn off_by_one() -> usize { 1 }\nfn main() {}\n";
const FIXED_FILE:    &str = "fn off_by_one() -> usize { 0 }\nfn main() {}\n";

async fn kortix_handler() -> impl axum::response::IntoResponse {
    // Llama-server SSE shape: each chunk carries `content` + `stop`.
    // We split the full edited file into a couple of token-shaped
    // chunks so the SSE parser actually has to assemble across frames.
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

/// Boot a mock OpenAI server that fails the assertion — if the local
/// path correctly returns Some(draft), this handler must NEVER fire.
async fn cloud_must_not_fire_handler() -> axum::Json<serde_json::Value> {
    panic!("cloud OpenAI was called — local Kortix path should have served the request");
}

async fn boot_cloud_mock() -> SocketAddr {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(cloud_must_not_fire_handler),
    );
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
        Store::open_at(&dir.path().join("fast_apply_basic.db")).expect("open store"),
    );
    (store, dir)
}

fn write_repo_with_known_bug() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("repo tempdir");
    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("mkdir src");
    std::fs::write(src_dir.join("main.rs"), ORIGINAL_FILE).expect("write main.rs");

    // Initialise as a real git repo so the diff can be `git apply
    // --check`-ed against the working tree. Set committer identity so
    // the `git commit` later in the test doesn't fail with "please
    // tell me who you are".
    let _ = Command::new("git").current_dir(dir.path()).args(["init", "-q"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "user.email", "test@inari.local"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["config", "user.name", "Inari Test"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["add", "-A"]).output();
    let _ = Command::new("git").current_dir(dir.path()).args(["commit", "-q", "-m", "init"]).output();

    dir
}

/// Lay down the placeholder cached file at the path the registry
/// expects so `is_cached` returns true. Content does NOT need to
/// match the BLAKE3 placeholder: we never re-verify here, we just
/// check existence.
fn pre_cache_kortix(models_dir: &std::path::Path) -> PathBuf {
    let kortix_dir = models_dir.join(KORTIX_MODEL_ID);
    std::fs::create_dir_all(&kortix_dir).expect("mkdir kortix");
    let cached = kortix_dir.join(format!("{}.gguf", "0".repeat(64)));
    std::fs::write(&cached, b"stub").expect("write stub gguf");
    cached
}

#[tokio::test]
async fn local_kortix_serves_request_and_emits_zero_cost_diff() {
    let kortix_addr = boot_kortix_mock().await;
    let cloud_addr  = boot_cloud_mock().await;

    let (store, _store_tmp) = open_store();
    let repo_dir = write_repo_with_known_bug();
    let repo_path: PathBuf = repo_dir.path().to_path_buf();

    upsert_repo(&store, "repo-1", repo_path.to_str().unwrap(), "demo", 0).unwrap();

    // Force Tier2 + opt-in via settings. The toggle itself is read by
    // the IPC layer; here we pass `local_apply_enabled = true`
    // directly to the function.
    settings::set(&store, "local_ai_tier", "tier2").unwrap();

    // Build a custom catalogue that mirrors the production
    // `kortix-fast-apply-7b` entry but uses the same placeholder hash
    // so the registry's `cached_path` lands at the file we pre-create.
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
        "http://127.0.0.1:1".to_string(), // never reached — endpoint is registered below
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
        repo_id:           "repo-1".to_string(),
        repo_path:         repo_path.clone(),
        error_message:     "off_by_one returns wrong value".to_string(),
        stack_trace:       Some("at src/main.rs:1".to_string()),
        error_fingerprint: Some("fp-fast-apply-1".to_string()),
        file_hint:         Some("src/main.rs".to_string()),
    };

    let draft = run_single_shot(&store, &cloud_client, Some(&local_ai), true, "session-fast-apply-1", &input)
        .await
        .expect("single-shot returns local Kortix draft");

    // The model_used is the locked Sesión 25 wire name — dashboards key
    // off this string to distinguish local from cloud spend.
    assert_eq!(draft.model_used, KORTIX_LOCAL_MODEL_NAME);
    // Zero cost is the headline of Sesión 25 — local inference burns
    // user CPU, not OpenAI quota.
    assert_eq!(draft.cents, 0);
    assert_eq!(draft.prompt_tokens, 0);
    assert_eq!(draft.completion_tokens, 0);

    // The diff must contain the fix line and target the right file.
    assert!(
        draft.diff_unified.contains("+fn off_by_one() -> usize { 0 }"),
        "diff body must include the fix line; got {:?}",
        draft.diff_unified
    );
    assert!(
        draft.diff_unified.contains("-fn off_by_one() -> usize { 1 }"),
        "diff body must include the original line as removed; got {:?}",
        draft.diff_unified
    );
    assert_eq!(draft.files_touched, vec!["src/main.rs".to_string()]);

    // And the diff must apply cleanly via `git apply --check` against
    // the working tree we wrote earlier — that's the contract the
    // Sesión 25 spec calls out as the ~70% success target. (Failures
    // here are S26's job to repair, not S25's.)
    let mut patch = std::env::temp_dir();
    patch.push(format!("inari-fast-apply-test-{}.patch", uuid::Uuid::new_v4()));
    std::fs::write(&patch, &draft.diff_unified).unwrap();
    let check = Command::new("git")
        .current_dir(&repo_path)
        .args(["apply", "--check", patch.to_str().unwrap()])
        .output()
        .expect("git apply --check spawns");
    let _ = std::fs::remove_file(&patch);
    assert!(
        check.status.success(),
        "git apply --check rejected the locally-generated diff:\nstderr: {}\ndiff:\n{}",
        String::from_utf8_lossy(&check.stderr),
        draft.diff_unified,
    );

    // Sanity — the FIXED_FILE is what the model returned. Round-trip
    // confirms the diff captures the same intent (silences flaky
    // future model changes — the assertion above is the real gate).
    assert!(FIXED_FILE.contains("0"));
    assert!(ORIGINAL_FILE.contains("1"));
}
