//! LSP wire protocol — JSON-RPC 2.0 over `Content-Length` framing.
//!
//! Hand-rolled (no `lsp-types` / `tower-lsp`) because the S22 surface is
//! small (initialize + didOpen|Change|Close + completion + codeAction +
//! hover + $/cancelRequest) and a hand-rolled parser keeps the dep graph
//! flat and the serialised wire shape under our control. See
//! `INARI_LIVE_DECISIONS.md` § Sesión 22 for the rationale.

use std::io;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// LSP request id. The spec allows numbers or strings; some clients also
/// send `null`, which we reject (per JSON-RPC 2.0 a `null` id signals a
/// notification, not a request).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

/// Inbound message — the variant is decided by which fields are present:
/// - `id` + `method` ⇒ Request
/// - `method` only   ⇒ Notification
/// - `id` + (`result` | `error`) ⇒ Response
#[derive(Debug)]
pub enum InboundMessage {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: RequestId,
        result: Option<Value>,
        error: Option<ResponseError>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ResponseError {
    pub fn parse_error(msg: impl Into<String>) -> Self {
        Self { code: -32700, message: msg.into(), data: None }
    }

    pub fn invalid_request(msg: impl Into<String>) -> Self {
        Self { code: -32600, message: msg.into(), data: None }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self { code: -32601, message: format!("method not found: {method}"), data: None }
    }

    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self { code: -32602, message: msg.into(), data: None }
    }

    pub fn internal_error(msg: impl Into<String>) -> Self {
        Self { code: -32603, message: msg.into(), data: None }
    }

    /// LSP-defined: -32800 RequestCancelled.
    pub fn request_cancelled() -> Self {
        Self { code: -32800, message: "request cancelled".into(), data: None }
    }
}

#[derive(Debug, Serialize)]
pub struct ResponseMessage {
    pub jsonrpc: &'static str,
    pub id: RequestId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResponseError>,
}

impl ResponseMessage {
    pub fn success(id: RequestId, result: Value) -> Self {
        Self { jsonrpc: "2.0", id, result: Some(result), error: None }
    }

    pub fn fail(id: RequestId, err: ResponseError) -> Self {
        Self { jsonrpc: "2.0", id, result: None, error: Some(err) }
    }
}

/// Notification (server → client). `id` MUST be absent (JSON-RPC 2.0).
#[derive(Debug, Serialize)]
pub struct NotificationMessage {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
}

impl NotificationMessage {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self { jsonrpc: "2.0", method: method.into(), params }
    }
}

/// Read one LSP-framed message body (stripped of headers). Returns
/// `Ok(None)` on clean EOF before any header bytes (peer hung up). Anything
/// after a partial header is treated as a malformed-stream error.
pub async fn read_message<R>(reader: &mut R) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut content_length: Option<usize> = None;
    let mut header_seen = false;
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            // EOF — clean only if no header bytes at all.
            return if header_seen {
                Err(io::Error::new(io::ErrorKind::UnexpectedEof, "EOF in header"))
            } else {
                Ok(None)
            };
        }
        header_seen = true;

        // End of headers: blank line "\r\n" (n==2) or "\n" on lenient peers.
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }

        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse::<usize>().ok();
            }
            // Other headers (Content-Type) are ignored.
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("malformed header line: {trimmed:?}"),
            ));
        }
    }

    let len = content_length.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length header")
    })?;

    // Safety cap — 8 MB of LSP message is already well past anything sane.
    const MAX_BODY: usize = 8 * 1024 * 1024;
    if len > MAX_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Content-Length {len} exceeds {MAX_BODY}"),
        ));
    }

    let mut body = vec![0u8; len];
    use tokio::io::AsyncReadExt;
    reader.read_exact(&mut body).await?;
    Ok(Some(body))
}

/// Write a JSON payload with the LSP framing prefix.
pub async fn write_message<W>(writer: &mut W, payload: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let header = format!("Content-Length: {}\r\n\r\n", payload.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

/// Decode a JSON body into one of the three message variants.
pub fn decode(body: &[u8]) -> Result<InboundMessage, ResponseError> {
    let v: Value = serde_json::from_slice(body)
        .map_err(|e| ResponseError::parse_error(format!("invalid JSON: {e}")))?;

    let obj = v.as_object().ok_or_else(|| {
        ResponseError::invalid_request("top-level value must be an object")
    })?;

    match obj.get("jsonrpc").and_then(Value::as_str) {
        Some("2.0") => {}
        _ => return Err(ResponseError::invalid_request("jsonrpc must be \"2.0\"")),
    }

    let id = obj.get("id").and_then(decode_id);
    let method = obj.get("method").and_then(Value::as_str).map(String::from);
    let params = obj.get("params").cloned().unwrap_or(Value::Null);

    match (id, method) {
        (Some(id), Some(method)) => Ok(InboundMessage::Request { id, method, params }),
        (None,     Some(method)) => Ok(InboundMessage::Notification { method, params }),
        (Some(id), None) => {
            let result = obj.get("result").cloned();
            let error = obj
                .get("error")
                .cloned()
                .map(|v| serde_json::from_value::<ResponseError>(v).ok())
                .flatten();
            Ok(InboundMessage::Response { id, result, error })
        }
        (None, None) => Err(ResponseError::invalid_request("message has neither id nor method")),
    }
}

fn decode_id(v: &Value) -> Option<RequestId> {
    match v {
        Value::Number(n) => n.as_i64().map(RequestId::Number),
        Value::String(s) => Some(RequestId::String(s.clone())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn read_message_decodes_framing() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"x","params":{}}"#;
        let mut blob = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        blob.extend_from_slice(body);
        let mut reader = BufReader::new(&blob[..]);
        let out = read_message(&mut reader).await.unwrap().unwrap();
        assert_eq!(out, body);
    }

    #[tokio::test]
    async fn read_message_clean_eof() {
        let blob: Vec<u8> = vec![];
        let mut reader = BufReader::new(&blob[..]);
        let out = read_message(&mut reader).await.unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn decode_request_notification_response() {
        let req = decode(br#"{"jsonrpc":"2.0","id":7,"method":"x","params":[1]}"#).unwrap();
        assert!(matches!(req, InboundMessage::Request { .. }));

        let n = decode(br#"{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":1}}"#).unwrap();
        assert!(matches!(n, InboundMessage::Notification { .. }));

        let r = decode(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#).unwrap();
        assert!(matches!(r, InboundMessage::Response { .. }));
    }
}
