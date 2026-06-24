//! `inari-lsp-stdio` — stdio ↔ TCP bridge for the Inari LSP server.
//!
//! Editors that drive LSP servers over stdio (VS Code, Cursor, Zed, most
//! Neovim plugins, JetBrains, Helix's default config) launch this
//! binary, send LSP frames on stdin, and read frames on stdout. The
//! bridge connects to `127.0.0.1:9877` (or `INARI_LSP_PORT` if set) and
//! pipes bytes in both directions verbatim — no parsing, no framing
//! inspection, so any breaking-change in the LSP frame format does not
//! require a sidecar release.
//!
//! Exit codes:
//!   0 — clean shutdown (peer or stdin closed)
//!   1 — connection error
//!   2 — invalid `INARI_LSP_PORT` value

use std::env;
use std::process::ExitCode;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let port: u16 = match env::var("INARI_LSP_PORT") {
        Ok(s) => match s.parse() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("[inari-lsp-stdio] invalid INARI_LSP_PORT={s:?}");
                return ExitCode::from(2);
            }
        },
        Err(_) => 9877,
    };

    let host = env::var("INARI_LSP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let addr = format!("{host}:{port}");

    let stream = match TcpStream::connect(&addr).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[inari-lsp-stdio] connect {addr} failed: {e}");
            return ExitCode::from(1);
        }
    };

    let (mut tcp_r, mut tcp_w) = stream.into_split();
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    // stdin → tcp
    let to_server = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0)  => break,
                Ok(n)  => {
                    if tcp_w.write_all(&buf[..n]).await.is_err() { break; }
                    if tcp_w.flush().await.is_err() { break; }
                }
                Err(_) => break,
            }
        }
        let _ = tcp_w.shutdown().await;
    });

    // tcp → stdout
    let to_client = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match tcp_r.read(&mut buf).await {
                Ok(0)  => break,
                Ok(n)  => {
                    if stdout.write_all(&buf[..n]).await.is_err() { break; }
                    if stdout.flush().await.is_err() { break; }
                }
                Err(_) => break,
            }
        }
    });

    // First side to finish wins; the other gets cancelled by drop.
    let _ = tokio::join!(to_server, to_client);
    ExitCode::SUCCESS
}
