//! stdio transport — line-delimited JSON-RPC frames over stdin/stdout.
//!
//! The daemon does NOT run a stdio server — Claude Code / Codex / etc.
//! spawn the sidecar binary `inari-mcp-stdio` (see `src/bin/`). That
//! binary is a tiny CLIENT that:
//!   1. Reads a JSON-RPC frame from stdin (one line = one frame).
//!   2. POSTs it to `127.0.0.1:<port>/mcp` with the local Bearer.
//!   3. Writes the response to stdout (one line).
//!
//! Process trust applies — only the user's own editor is meant to
//! spawn the sidecar.
//!
//! This module exposes `read_frame` / `write_frame` helpers so the
//! sidecar AND a future "in-process stdio sensor" (if we ever decide
//! to host stdio inside the daemon) share the same framing.

use std::io::{BufRead, Write};

use serde_json::Value;

use super::error::McpError;

/// Read one JSON-RPC frame (one line). Returns `Ok(None)` on clean
/// EOF; `Err` on partial / invalid input.
pub fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<String>, McpError> {
    let mut buf = String::new();
    let n = reader.read_line(&mut buf).map_err(|e| McpError::InternalError {
        message: format!("stdio read failed: {e}"),
    })?;
    if n == 0 {
        return Ok(None);
    }
    let trimmed = buf.trim_end_matches(['\n', '\r']).to_string();
    if trimmed.is_empty() {
        return Ok(Some(String::new()));
    }
    Ok(Some(trimmed))
}

/// Write one JSON-RPC frame, terminated with `\n`.
pub fn write_frame<W: Write>(writer: &mut W, payload: &Value) -> Result<(), McpError> {
    let raw = serde_json::to_string(payload)
        .map_err(|e| McpError::InternalError { message: e.to_string() })?;
    writer.write_all(raw.as_bytes())
        .map_err(|e| McpError::InternalError { message: e.to_string() })?;
    writer.write_all(b"\n")
        .map_err(|e| McpError::InternalError { message: e.to_string() })?;
    writer.flush()
        .map_err(|e| McpError::InternalError { message: e.to_string() })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn read_frame_returns_one_line() {
        let mut input = Cursor::new(b"hello\nworld\n".to_vec());
        let a = read_frame(&mut input).unwrap();
        let b = read_frame(&mut input).unwrap();
        assert_eq!(a.as_deref(), Some("hello"));
        assert_eq!(b.as_deref(), Some("world"));
    }

    #[test]
    fn read_frame_eof() {
        let mut input = Cursor::new(b"".to_vec());
        let a = read_frame(&mut input).unwrap();
        assert_eq!(a, None);
    }

    #[test]
    fn write_frame_appends_newline() {
        let mut out = Vec::new();
        write_frame(&mut out, &serde_json::json!({"k":1})).unwrap();
        assert_eq!(out, b"{\"k\":1}\n");
    }
}
