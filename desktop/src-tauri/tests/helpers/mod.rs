//! Shared LSP wire helpers for the S22 integration tests.
//!
//! Put under `tests/helpers/mod.rs` so each integration test file can
//! `mod helpers;` and pull in the framing primitives without duplication.
//! Cargo treats each top-level `tests/<file>.rs` as its own crate but
//! `tests/helpers/mod.rs` is mounted as a submodule by each.

#![allow(dead_code)] // each test pulls in only the helpers it needs

use std::io;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncReadExt, AsyncWriteExt};

pub async fn write_lsp_message<W: AsyncWrite + Unpin>(w: &mut W, payload: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(payload).expect("serialize");
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    w.write_all(header.as_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}

pub async fn read_lsp_message<R: AsyncBufRead + Unpin>(r: &mut R) -> io::Result<Value> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();

    loop {
        line.clear();
        let n = r.read_line(&mut line).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "EOF in header"));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse::<usize>().ok();
            }
        }
    }

    let len = content_length
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    let v: Value = serde_json::from_slice(&body)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("json: {e}")))?;
    Ok(v)
}
