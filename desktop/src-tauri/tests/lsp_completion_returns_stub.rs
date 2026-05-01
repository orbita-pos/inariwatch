//! S22 acceptance: with no model loaded, `textDocument/completion`
//! returns an empty `CompletionList`. Sesión 23 swaps this for a real
//! FIM call against `LocalAI::generate(.., fim_mode=true)`.

use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use inariwatch_desktop_lib::lsp::start_lsp_server_for_test;

mod helpers;
use helpers::{read_lsp_message, write_lsp_message};

#[tokio::test]
async fn completion_returns_empty_list_when_no_model() {
    let (addr, _state) = start_lsp_server_for_test().await.expect("bind");
    let stream = TcpStream::connect(addr).await.expect("connect");
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);

    // 1. initialize so completion is no longer ServerNotInitialized.
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "processId": null, "rootUri": null, "capabilities": {} }
    });
    write_lsp_message(&mut w, &init).await.expect("send init");
    let _ = read_lsp_message(&mut r).await.expect("init resp");

    // 2. completion request.
    let comp = json!({
        "jsonrpc": "2.0", "id": 2, "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///main.rs" },
            "position":     { "line": 0, "character": 0 }
        }
    });
    write_lsp_message(&mut w, &comp).await.expect("send completion");

    let resp = tokio::time::timeout(Duration::from_secs(5), read_lsp_message(&mut r))
        .await
        .expect("response did not arrive within 5s")
        .expect("read response");

    assert_eq!(resp["id"], 2);
    assert!(resp["error"].is_null(), "unexpected error: {}", resp["error"]);

    let result = &resp["result"];
    assert_eq!(result["isIncomplete"], false);
    let items = result["items"].as_array().expect("items array");
    assert!(items.is_empty(), "expected empty items, got {}", items.len());

    let _ = w.shutdown().await;
}
