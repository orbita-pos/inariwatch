//! S22 acceptance: a `$/cancelRequest` notification aborts the matching
//! pending `textDocument/completion` call within ~50ms (well under the
//! handler's 500ms artificial delay), and the response carries the LSP
//! cancellation error code -32800.

use std::time::{Duration, Instant};

use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use inariwatch_desktop_lib::lsp::start_lsp_server_for_test;

mod helpers;
use helpers::{read_lsp_message, write_lsp_message};

#[tokio::test]
async fn cancel_request_aborts_pending_completion() {
    let (addr, state) = start_lsp_server_for_test().await.expect("bind");

    // Make completion observably pending for 500ms so the cancel race
    // is real. Without this, the stub returns instantly and the cancel
    // is a noop on the wire (also a valid outcome, but doesn't prove
    // the cancel pathway works).
    state.set_completion_delay_ms(500);

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

    // Fire completion.
    let comp = json!({
        "jsonrpc": "2.0", "id": 2, "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": "file:///main.rs" },
            "position":     { "line": 0, "character": 0 }
        }
    });
    write_lsp_message(&mut w, &comp).await.expect("send completion");

    // Give the server a moment to register the pending request, then
    // cancel.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let cancel = json!({
        "jsonrpc": "2.0",
        "method":  "$/cancelRequest",
        "params":  { "id": 2 }
    });
    let cancel_at = Instant::now();
    write_lsp_message(&mut w, &cancel).await.expect("send cancel");

    let resp = tokio::time::timeout(Duration::from_millis(400), read_lsp_message(&mut r))
        .await
        .expect("cancel did not abort the request within 400ms")
        .expect("read response");

    let elapsed = cancel_at.elapsed();
    assert!(
        elapsed < Duration::from_millis(400),
        "cancel→response took {:?}, expected <400ms",
        elapsed
    );

    assert_eq!(resp["id"], 2);
    assert_eq!(resp["error"]["code"], -32800);
    assert!(resp["error"]["message"]
        .as_str()
        .map(|s| s.contains("cancel"))
        .unwrap_or(false));

    let _ = w.shutdown().await;
}
