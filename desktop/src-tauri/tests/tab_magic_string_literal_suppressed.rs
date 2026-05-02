//! Sesión 24 — smart triggers suppress completion inside string
//! literals. The handler must return an EMPTY completion list without
//! ever calling llama-server.
//!
//! Mock contract: if the LSP fires a completion request despite the
//! string-literal context, the test would observe the mock's
//! `requests_received` counter incremented. The assertion below proves
//! both: (a) the response is empty, AND (b) the mock saw zero hits.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    response::{sse::Event, Sse},
    routing::post,
    Router,
};
use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use inariwatch_desktop_lib::local_ai::{
    registry::{ModelFamily, ModelSpec},
    LocalAI, ModelRegistry, RuntimeManager, SidecarPaths,
};
use inariwatch_desktop_lib::lsp::start_lsp_server_for_test;
use inariwatch_desktop_lib::store::Store;

mod helpers;
use helpers::{read_lsp_message, write_lsp_message};

const MODEL_ID: &str = "qwen2.5-coder-1.5b";

#[derive(Clone)]
struct MockState {
    counter: Arc<AtomicUsize>,
}

async fn completion_handler(
    axum::extract::State(state): axum::extract::State<MockState>,
) -> impl axum::response::IntoResponse {
    state.counter.fetch_add(1, Ordering::Relaxed);
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(r#"{"content":"unexpected","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"","stop":true,"stop_type":"stop"}"#)),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot_mock() -> (SocketAddr, Arc<AtomicUsize>) {
    let counter = Arc::new(AtomicUsize::new(0));
    let state = MockState { counter: counter.clone() };
    let app = Router::new()
        .route("/completion", post(completion_handler))
        .with_state(state);
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    (addr, counter)
}

async fn build_local_ai(tmp: &tempfile::TempDir, mock_addr: SocketAddr) -> LocalAI {
    let store = Arc::new(Store::open_at(&tmp.path().join("store.db")).unwrap());
    let spec = ModelSpec {
        id:           MODEL_ID.to_string(),
        display_name: "Qwen-1.5B (test)".to_string(),
        blake3_hex:   "0".repeat(64),
        size_bytes:   1,
        family:       ModelFamily::Tab,
    };
    let registry = ModelRegistry::new_with_paths(
        store,
        tmp.path().join("models"),
        vec![spec],
        "http://127.0.0.1:1".to_string(),
    )
    .unwrap();
    let runtime = RuntimeManager::new(SidecarPaths::default());
    runtime
        .register_external_endpoint(MODEL_ID.to_string(), format!("http://{mock_addr}"))
        .await;
    LocalAI::from_parts(registry, runtime)
}

#[tokio::test]
async fn cursor_inside_typescript_string_returns_empty_without_calling_model() {
    let tmp = tempfile::tempdir().unwrap();
    let (mock_addr, counter) = boot_mock().await;
    let local_ai = build_local_ai(&tmp, mock_addr).await;

    let (addr, state) = start_lsp_server_for_test().await.expect("bind");
    state.set_local_ai(local_ai);

    let stream = TcpStream::connect(addr).await.expect("connect");
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);

    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "processId": null, "rootUri": null, "capabilities": {} }
    });
    write_lsp_message(&mut w, &init).await.expect("send init");
    let _ = read_lsp_message(&mut r).await.expect("init resp");

    // Cursor sits inside the string literal between "hello " and "\"".
    let did_open = json!({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri":        "file:///main.ts",
                "languageId": "typescript",
                "version":    1,
                "text":       "const greet = \"hello \";\n"
            }
        }
    });
    write_lsp_message(&mut w, &did_open).await.expect("didOpen");

    // Position: line 0, character 21 — inside the "hello " literal.
    let comp = json!({
        "jsonrpc": "2.0", "id": 2, "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///main.ts" },
            "position":     { "line": 0, "character": 21 }
        }
    });
    write_lsp_message(&mut w, &comp).await.expect("completion");

    let resp = tokio::time::timeout(Duration::from_secs(5), read_lsp_message(&mut r))
        .await
        .expect("response within 5s")
        .expect("read response");

    assert_eq!(resp["id"], 2);
    assert!(resp["error"].is_null(), "unexpected error: {}", resp["error"]);
    let items = resp["result"]["items"].as_array().expect("items array");
    assert!(items.is_empty(), "expected empty completion in string literal, got {items:?}");
    assert_eq!(
        counter.load(Ordering::Relaxed),
        0,
        "trigger should suppress BEFORE calling llama-server"
    );

    let _ = w.shutdown().await;
}
