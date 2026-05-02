//! Sesión 24 — LRU cache. After a successful completion, a second
//! completion request at the same `(buffer, byte_offset)` MUST be
//! served from the cache without firing any new HTTP requests against
//! llama-server.
//!
//! Verification:
//!   * First call fires `n=3` → counter == 3, item populated.
//!   * Second call (same params) → counter still 3, item identical.

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
        Ok(Event::default().data(r#"{"content":"hello","stop":false}"#)),
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
async fn second_completion_at_same_position_serves_from_cache() {
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

    let text = "fn main() {\n    \n}\n";
    let did_open = json!({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri":        "file:///main.rs",
                "languageId": "rust",
                "version":    1,
                "text":       text,
            }
        }
    });
    write_lsp_message(&mut w, &did_open).await.expect("didOpen");

    // First completion request.
    let comp1 = json!({
        "jsonrpc": "2.0", "id": 2, "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///main.rs" },
            "position":     { "line": 1, "character": 4 }
        }
    });
    write_lsp_message(&mut w, &comp1).await.expect("completion 1");

    let resp1 = tokio::time::timeout(Duration::from_secs(5), read_lsp_message(&mut r))
        .await
        .expect("response 1 within 5s")
        .expect("read response 1");
    assert_eq!(resp1["id"], 2);
    let items1 = resp1["result"]["items"].as_array().expect("items1");
    assert_eq!(items1.len(), 1, "first call should produce a candidate");
    let first_text = items1[0]["insertText"].as_str().expect("insertText").to_string();
    let after_first = counter.load(Ordering::Relaxed);
    assert_eq!(after_first, 3, "first call fires n=3 requests");

    // Second completion request — IDENTICAL params. Should hit cache.
    let comp2 = json!({
        "jsonrpc": "2.0", "id": 3, "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///main.rs" },
            "position":     { "line": 1, "character": 4 }
        }
    });
    write_lsp_message(&mut w, &comp2).await.expect("completion 2");

    let resp2 = tokio::time::timeout(Duration::from_secs(5), read_lsp_message(&mut r))
        .await
        .expect("response 2 within 5s")
        .expect("read response 2");
    assert_eq!(resp2["id"], 3);
    let items2 = resp2["result"]["items"].as_array().expect("items2");
    assert_eq!(items2.len(), 1, "cached call still returns the candidate");
    assert_eq!(items2[0]["insertText"].as_str().unwrap(), first_text);
    let after_second = counter.load(Ordering::Relaxed);
    assert_eq!(after_second, 3, "second call MUST NOT hit llama-server");

    let _ = w.shutdown().await;
}
