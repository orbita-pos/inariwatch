//! Sesión 23 acceptance: a `$/cancelRequest` aborts an in-flight
//! `textDocument/completion` whose underlying `LocalAI::generate` call
//! is hanging on a slow llama-server. The cancel→response delta must
//! stay under 400ms (well below the 50ms target the HANDOFF doc cites,
//! but generous enough for CI noise).
//!
//! The mock server's handler sleeps for 10s before any response, so
//! without cancellation the LSP client would wait the full 10s.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{response::IntoResponse, routing::post, Router};
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

async fn slow_handler() -> impl IntoResponse {
    // Hold the connection open until the client drops. Cancellation
    // drops the LocalAI::generate future → reqwest closes the TCP
    // connection → axum's request task sees the disconnect.
    tokio::time::sleep(Duration::from_secs(10)).await;
    "never sent"
}

async fn boot_slow_server() -> SocketAddr {
    let app = Router::new().route("/completion", post(slow_handler));
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
async fn cancel_request_aborts_pending_fim_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let mock_addr = boot_slow_server().await;
    let local_ai = build_local_ai(&tmp, mock_addr).await;

    let (addr, state) = start_lsp_server_for_test().await.expect("bind");
    state.set_local_ai(local_ai);

    let stream = TcpStream::connect(addr).await.expect("connect");
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);

    // initialize
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "processId": null, "rootUri": null, "capabilities": {} }
    });
    write_lsp_message(&mut w, &init).await.expect("send init");
    let _ = read_lsp_message(&mut r).await.expect("init resp");

    // didOpen
    let did_open = json!({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri":        "file:///main.rs",
                "languageId": "rust",
                "version":    1,
                "text":       "fn main() { }"
            }
        }
    });
    write_lsp_message(&mut w, &did_open).await.expect("didOpen");

    // completion (will hang against the slow mock until cancel fires)
    let comp = json!({
        "jsonrpc": "2.0", "id": 2, "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///main.rs" },
            "position":     { "line": 0, "character": 11 }
        }
    });
    write_lsp_message(&mut w, &comp).await.expect("completion");

    // Give the LSP server time to register the pending request and
    // dispatch it through to LocalAI::generate (which is now
    // suspended awaiting the slow mock's response).
    tokio::time::sleep(Duration::from_millis(150)).await;

    let cancel = json!({
        "jsonrpc": "2.0",
        "method":  "$/cancelRequest",
        "params":  { "id": 2 }
    });
    let cancel_at = Instant::now();
    write_lsp_message(&mut w, &cancel).await.expect("send cancel");

    let resp = tokio::time::timeout(Duration::from_millis(400), read_lsp_message(&mut r))
        .await
        .expect("cancel did not abort the pending FIM completion within 400ms")
        .expect("read response");

    let elapsed = cancel_at.elapsed();
    assert!(
        elapsed < Duration::from_millis(400),
        "cancel→response took {:?}, expected <400ms",
        elapsed
    );
    assert_eq!(resp["id"], 2);
    assert_eq!(resp["error"]["code"], -32800);

    let _ = w.shutdown().await;
}
