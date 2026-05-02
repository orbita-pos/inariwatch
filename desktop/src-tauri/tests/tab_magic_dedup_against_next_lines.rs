//! Sesión 24 — dedup. When the model returns text that matches the
//! next 3 lines of the document verbatim (or whitespace-tolerant), the
//! completion is suppressed. Better UX: the user already has those
//! lines below the cursor; suggesting them again is noise.

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
    // The mock returns text identical to the doc's next 3 lines.
    // Newline framing in SSE `data:` is finicky — we send each line
    // as its own SSE event, then a stop event.
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(r#"{"content":"let x = 1;","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"\n    ","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"let y = 2;","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"\n    ","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"let z = 3;","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"","stop":true,"stop_type":"stop"}"#)),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot_mock() -> SocketAddr {
    let app = Router::new().route("/completion", post(completion_handler));
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    addr
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
async fn completion_matching_next_3_lines_is_suppressed() {
    let tmp = tempfile::tempdir().unwrap();
    let mock_addr = boot_mock().await;
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

    // Document already contains exactly the lines the mock will
    // generate, starting at the cursor position.
    let text = "fn main() {\n    let x = 1;\n    let y = 2;\n    let z = 3;\n}\n";
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

    // Cursor sits exactly before the `let x = 1;` line so the next
    // 3 lines of the document match the mock's output.
    // Line 1, character 4 is right at the `l` of `let x`.
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
    assert!(items.is_empty(),
        "completion matching next 3 lines should be deduped, got {items:?}");

    let _ = w.shutdown().await;
}
