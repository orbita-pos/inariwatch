//! S22 acceptance: `didOpen → didChange → didClose` correctly mutates
//! the server-side document cache.

use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use inariwatch_desktop_lib::lsp::start_lsp_server_for_test;

mod helpers;
use helpers::{read_lsp_message, write_lsp_message};

const URI: &str = "file:///main.rs";

#[tokio::test]
async fn document_sync_open_change_close_updates_cache() {
    let (addr, state) = start_lsp_server_for_test().await.expect("bind");

    let stream = TcpStream::connect(addr).await.expect("connect");
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);

    // initialize so we know the server is up + reading.
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "processId": null, "rootUri": null, "capabilities": {} }
    });
    write_lsp_message(&mut w, &init).await.expect("send init");
    let _ = read_lsp_message(&mut r).await.expect("init resp");

    // didOpen
    let did_open = json!({
        "jsonrpc": "2.0",
        "method":  "textDocument/didOpen",
        "params":  {
            "textDocument": {
                "uri":        URI,
                "languageId": "rust",
                "version":    1,
                "text":       "fn main() {}"
            }
        }
    });
    write_lsp_message(&mut w, &did_open).await.expect("send didOpen");

    // Notifications have no response — we instead poll the shared state
    // for up to 1s.
    wait_until(Duration::from_secs(1), || state.documents.contains(URI)).await;
    assert_eq!(state.documents.get(URI).unwrap().text, "fn main() {}");
    assert_eq!(state.documents.get(URI).unwrap().version, 1);

    // didChange — incremental edit, replace `main` (line 0, chars 3..7) with `square`.
    let did_change = json!({
        "jsonrpc": "2.0",
        "method":  "textDocument/didChange",
        "params":  {
            "textDocument": { "uri": URI, "version": 2 },
            "contentChanges": [{
                "range": {
                    "start": { "line": 0, "character": 3 },
                    "end":   { "line": 0, "character": 7 }
                },
                "text": "square"
            }]
        }
    });
    write_lsp_message(&mut w, &did_change).await.expect("send didChange");

    wait_until(Duration::from_secs(1), || {
        state.documents.get(URI).map(|d| d.version == 2).unwrap_or(false)
    })
    .await;
    assert_eq!(state.documents.get(URI).unwrap().text, "fn square() {}");
    assert_eq!(state.documents.get(URI).unwrap().version, 2);

    // didClose
    let did_close = json!({
        "jsonrpc": "2.0",
        "method":  "textDocument/didClose",
        "params":  { "textDocument": { "uri": URI } }
    });
    write_lsp_message(&mut w, &did_close).await.expect("send didClose");

    wait_until(Duration::from_secs(1), || !state.documents.contains(URI)).await;
    assert!(!state.documents.contains(URI));

    let _ = w.shutdown().await;
}

async fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
