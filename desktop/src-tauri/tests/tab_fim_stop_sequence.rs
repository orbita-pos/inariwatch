//! Sesión 23 acceptance: the completion handler forwards the
//! `stop_seqs: ["\n\n"]` to llama-server and stops accumulating tokens
//! when the server emits a chunk with `stop:true,stop_type:"stop"`.
//!
//! The mock server **inspects** the request body to confirm we sent
//! `stop: ["\n\n"]` (the contract llama-server expects for "stop on
//! double-newline"), then replies with a streamed payload that ends
//! with a `stop_type: "stop"` chunk.
//!
//! What this proves:
//! - The handler hands `["\n\n"]` to `LocalAI::generate` → llama-server
//!   would actually use it server-side to truncate generation.
//! - The handler observes the `stop` flag and stops accumulating; tokens
//!   that arrive AFTER the stop chunk are dropped (mirrors llama-server
//!   behaviour where extra tokens shouldn't arrive but the loop must not
//!   wait for them).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::Json,
    response::{sse::Event, Sse},
    routing::post,
    Router,
};
use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

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
struct CapturedRequest {
    tx: Arc<tokio::sync::Mutex<Option<oneshot::Sender<Value>>>>,
}

async fn completion_handler(
    axum::extract::State(captured): axum::extract::State<CapturedRequest>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    // Send the captured request body back through the oneshot so the
    // test can assert against it. Best-effort: the receiver may have
    // already been consumed if the test re-drives the endpoint.
    if let Some(tx) = captured.tx.lock().await.take() {
        let _ = tx.send(body);
    }

    // Stream the canonical "model produced 'hello' then stopped on its
    // configured stop_seq" response shape. The handler should:
    //   1. accumulate "hello"
    //   2. observe stop=true,stop_type="stop"
    //   3. stop reading
    //   4. emit a CompletionItem whose insertText == "hello"
    let chunks: Vec<Result<Event, std::convert::Infallible>> = vec![
        Ok(Event::default().data(r#"{"content":"hello","stop":false}"#)),
        Ok(Event::default().data(r#"{"content":"","stop":true,"stop_type":"stop"}"#)),
        // This trailing chunk must not be observed — the handler should
        // have broken out of the accumulation loop after the stop chunk.
        Ok(Event::default().data(r#"{"content":"AFTER_STOP","stop":false}"#)),
    ];
    let stream = futures_util::stream::iter(chunks);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

async fn boot_capture_server() -> (SocketAddr, oneshot::Receiver<Value>) {
    let (tx, rx) = oneshot::channel::<Value>();
    let captured = CapturedRequest {
        tx: Arc::new(tokio::sync::Mutex::new(Some(tx))),
    };
    let app = Router::new()
        .route("/completion", post(completion_handler))
        .with_state(captured);
    let l = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(40)).await;
    (addr, rx)
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
async fn completion_forwards_stop_seqs_and_stops_at_stop_chunk() {
    let tmp = tempfile::tempdir().unwrap();
    let (mock_addr, captured_rx) = boot_capture_server().await;
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
    // The trailing "AFTER_STOP" chunk should NOT have been accumulated.
    assert_eq!(items[0]["insertText"], "hello");

    // Verify the request body the handler sent to llama-server. This is
    // what proves stop sequences are wired through correctly.
    let body = tokio::time::timeout(Duration::from_secs(2), captured_rx)
        .await
        .expect("request body captured")
        .expect("oneshot delivered");
    let stops = body["stop"].as_array().expect("stop array in request body");
    assert_eq!(stops.len(), 1);
    assert_eq!(stops[0], "\n\n");

    // Bonus: confirm fim_mode + max_tokens reach llama-server too.
    assert_eq!(body["fim_mode"], true);
    assert_eq!(body["n_predict"], 64);

    // And the prompt carries the FIM sentinels so llama-server's
    // tokenizer can recognise the FIM control tokens.
    let prompt = body["prompt"].as_str().expect("prompt is a string");
    assert!(prompt.contains("<|fim_prefix|>"));
    assert!(prompt.contains("<|fim_suffix|>"));
    assert!(prompt.contains("<|fim_middle|>"));

    let _ = w.shutdown().await;
}
