//! S22 acceptance: a client connecting to the bound LSP listener can
//! complete the LSP `initialize` handshake and observe the advertised
//! capability set.

use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use inariwatch_desktop_lib::lsp::start_lsp_server_for_test;

mod helpers;
use helpers::{read_lsp_message, write_lsp_message};

#[tokio::test]
async fn initialize_handshake_returns_capabilities() {
    let (addr, _state) = start_lsp_server_for_test().await.expect("bind");
    let stream = TcpStream::connect(addr).await.expect("connect");
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);

    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": null,
            "rootUri":   null,
            "capabilities": {}
        }
    });
    write_lsp_message(&mut w, &req).await.expect("write initialize");

    let resp = tokio::time::timeout(Duration::from_secs(5), read_lsp_message(&mut r))
        .await
        .expect("response did not arrive within 5s")
        .expect("read response");

    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 1);
    let caps = &resp["result"]["capabilities"];
    assert_eq!(caps["textDocumentSync"]["openClose"], true);
    assert_eq!(caps["textDocumentSync"]["change"], 2);
    assert!(caps["completionProvider"].is_object());
    assert_eq!(caps["codeActionProvider"], true);
    assert_eq!(caps["hoverProvider"], true);
    assert_eq!(caps["positionEncoding"], "utf-16");
    assert_eq!(resp["result"]["serverInfo"]["name"], "inari-lsp");

    let _ = w.shutdown().await;
}
