//! Sesión 23 acceptance: with a stubbed llama-server returning two
//! tokens (`"fn "` then `"add"`) followed by a stop chunk, the LSP
//! `textDocument/completion` response carries a single CompletionItem
//! whose `insertText` is the concatenation `"fn add"`.

use std::net::SocketAddr;
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

async fn completion_handler() -> impl axum::response::IntoResponse {
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(r#"{"content":"fn ","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"add","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"","stop":true,"stop_type":"stop"}"#)),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot_mock_server() -> SocketAddr {
    let app = Router::new().route("/completion", post(completion_handler));
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
}

async fn build_local_ai_with_endpoint(
    tmp: &tempfile::TempDir,
    mock_addr: SocketAddr,
) -> LocalAI {
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
    // Pre-register the mock endpoint so generate() skips the
    // download/spawn path entirely.
    runtime
        .register_external_endpoint(MODEL_ID.to_string(), format!("http://{mock_addr}"))
        .await;
    LocalAI::from_parts(registry, runtime)
}

#[tokio::test]
async fn completion_returns_streamed_text_as_insert_text() {
    let tmp = tempfile::tempdir().unwrap();
    let mock_addr = boot_mock_server().await;
    let local_ai = build_local_ai_with_endpoint(&tmp, mock_addr).await;

    let (addr, state) = start_lsp_server_for_test().await.expect("bind");
    state.set_local_ai(local_ai);

    let stream = TcpStream::connect(addr).await.expect("connect");
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);

    // 1. initialize
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "processId": null, "rootUri": null, "capabilities": {} }
    });
    write_lsp_message(&mut w, &init).await.expect("send init");
    let _ = read_lsp_message(&mut r).await.expect("init resp");

    // 2. didOpen — give the server a document so the FIM context is non-empty.
    let did_open = json!({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri":        "file:///main.rs",
                "languageId": "rust",
                "version":    1,
                "text":       "fn main() {\n    \n}\n"
            }
        }
    });
    write_lsp_message(&mut w, &did_open).await.expect("didOpen");

    // 3. completion at line 1 char 4 (cursor inside the indented blank line).
    let comp = json!({
        "jsonrpc": "2.0", "id": 2, "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///main.rs" },
            "position":     { "line": 1, "character": 4 }
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
    assert_eq!(items.len(), 1, "expected one CompletionItem, got {items:?}");
    assert_eq!(items[0]["insertText"], "fn add");
    assert_eq!(items[0]["label"], "fn add");

    let _ = w.shutdown().await;
}
