//! OpenAI Chat Completions client.
//!
//! Two surfaces:
//!   - [`OpenAIClient::chat_stream`] — streaming chat. Returns a
//!     [`futures_util::Stream`] of [`ChatChunk`] items so the dock can
//!     paint tokens as they arrive (TTFT is the headline UX metric).
//!   - [`OpenAIClient::chat_complete`] — one-shot non-streaming chat,
//!     used by `auto_analyze` and `diagnose` paths.
//!
//! Plus an `embeddings` stub that returns
//! [`OpenAIError::NotImplemented`] until Sesión 13 wires it into the
//! indexer.
//!
//! Key resolution: BYOK from the settings store → `PLATFORM_AI_KEY`
//! env var → fail-closed [`OpenAIError::NoKey`].
//!
//! SSE parsing is hand-rolled (no `eventsource-stream` dep). OpenAI's
//! framing is `data: <line>\n\n` blocks with optional retry comments
//! we ignore + a `data: [DONE]` terminator. ~40 lines below.
//!
//! Retries: 3 attempts on 429 / 5xx with exponential backoff (1s / 2s).
//! Other 4xx never retries — surfaces immediately. The retry only
//! covers the request-establishment phase; once we've produced a
//! [`Stream`] the caller owns its lifecycle.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use thiserror::Error;

use crate::store::{settings, Store};

use super::budget::Model;
use super::prompts::{ChatMessage, Role};

/// Default OpenAI base URL. Tests override via [`OpenAIClient::with_base_url`].
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com";

/// Env var the platform key lives under. Synced from the web onto disk
/// (Sesión 4 device-flow auth) — eventually we can read it from
/// `auth.json`; for now `std::env::var` is enough since the desktop
/// inherits it through Tauri's environment.
pub const PLATFORM_KEY_ENV: &str = "PLATFORM_AI_KEY";

#[derive(Debug, Error)]
pub enum OpenAIError {
    #[error("no API key configured (set BYOK in Settings → AI or PLATFORM_AI_KEY env)")]
    NoKey,
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("OpenAI returned {status}: {body}")]
    Api { status: u16, body: String },
    #[error("invalid JSON in stream chunk: {0}")]
    BadChunk(String),
    #[error("not implemented in this build (Sesión 13 wires embeddings)")]
    NotImplemented,
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
}

/// One streamed chunk from the chat completion. Mirrors OpenAI's
/// `chat.completion.chunk` schema, narrowed to the fields we care
/// about. The trailing chunk's `usage` is populated when we asked for
/// it in the request body (`stream_options.include_usage = true`).
#[derive(Debug, Clone)]
pub struct ChatChunk {
    /// Delta token. Empty on the very first chunk (which only carries
    /// the `role` field) and on the final chunk (which only carries
    /// `finish_reason` / `usage`).
    pub delta:         String,
    /// `"stop"` / `"length"` / `"content_filter"` / `"tool_calls"` —
    /// `Some(_)` on the chunk that closes the stream.
    pub finish_reason: Option<String>,
    /// Optional usage block carried by the final chunk.
    pub usage:         Option<UsageReport>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct UsageReport {
    pub prompt_tokens:     u32,
    pub completion_tokens: u32,
}

/// Non-streaming chat response. Used by `chat_complete`.
#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: String,
    pub usage:   UsageReport,
    pub model:   String,
}

#[derive(Clone)]
pub struct OpenAIClient {
    http:     reqwest::Client,
    api_key:  String,
    base_url: String,
}

impl OpenAIClient {
    /// Build a client by resolving the active key from the settings
    /// store. Falls back to [`PLATFORM_KEY_ENV`]; returns [`NoKey`] if
    /// neither source is populated.
    pub fn from_store(store: &Arc<Store>) -> Result<Self, OpenAIError> {
        let key = resolve_key(store)?;
        Ok(Self::with_key(key))
    }

    /// Build a client from a literal key. Used in tests + by callers
    /// that already resolved the key (e.g. budget gate).
    pub fn with_key(key: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            // 30 s socket timeout. SSE keeps the response open longer
            // than this — the timeout applies to TCP connect + headers,
            // not the total stream duration. reqwest 0.12 documents
            // this behavior.
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client builds with default config");

        Self {
            http,
            api_key:  key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
        }
    }

    /// Override the base URL. Tests use this to point the client at a
    /// local mock server.
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    /// Streaming chat. Caller awaits the returned future to get a
    /// [`Stream`] of [`ChatChunk`] items. The stream ends when OpenAI
    /// emits `data: [DONE]` (translated into a final chunk with
    /// `finish_reason: Some(_)`) or the connection drops.
    ///
    /// Retries the *request kickoff* (headers + first byte of body) up
    /// to 3 times on 429 / 5xx with 1 s / 2 s backoff. Once we have a
    /// successful 200 the stream is the caller's lifecycle.
    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        model:    Model,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<ChatChunk, OpenAIError>> + Send>>, OpenAIError> {
        let body = build_request_body(messages, model, true);
        let url  = format!("{}/v1/chat/completions", self.base_url.trim_end_matches('/'));

        let resp = self.send_with_retry(&url, &body).await?;

        let bytes_stream = resp.bytes_stream();
        let chunk_stream = sse_chunks(bytes_stream);
        Ok(Box::pin(chunk_stream))
    }

    /// One-shot non-streaming chat. Returns the assembled response
    /// content + token usage.
    pub async fn chat_complete(
        &self,
        messages: &[ChatMessage],
        model:    Model,
    ) -> Result<ChatResponse, OpenAIError> {
        let body = build_request_body(messages, model, false);
        let url  = format!("{}/v1/chat/completions", self.base_url.trim_end_matches('/'));

        let resp = self.send_with_retry(&url, &body).await?;
        let parsed: ChatCompletion = resp.json().await?;

        let content = parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .unwrap_or_default();
        let usage = parsed.usage.unwrap_or_default();

        Ok(ChatResponse {
            content,
            usage:   UsageReport {
                prompt_tokens:     usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
            },
            model:   parsed.model,
        })
    }

    /// Stub — Sesión 13 wires the indexer's embedding path against
    /// `text-embedding-3-small` and the existing pgvector store. The
    /// shape lands here so callers can compile against it in S18 and
    /// S13 only changes the body.
    pub async fn embeddings(
        &self,
        _texts: Vec<String>,
    ) -> Result<Vec<Vec<f32>>, OpenAIError> {
        Err(OpenAIError::NotImplemented)
    }

    async fn send_with_retry(
        &self,
        url:  &str,
        body: &Json,
    ) -> Result<reqwest::Response, OpenAIError> {
        const MAX_ATTEMPTS: u32 = 3;
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let resp_res = self.http
                .post(url)
                .bearer_auth(&self.api_key)
                .json(body)
                .send()
                .await;

            match resp_res {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        return Ok(resp);
                    }
                    let code = status.as_u16();
                    let retryable = code == 429 || (500..=599).contains(&code);
                    if retryable && attempt < MAX_ATTEMPTS {
                        backoff(attempt).await;
                        continue;
                    }
                    let body_text = resp.text().await.unwrap_or_default();
                    return Err(OpenAIError::Api { status: code, body: redact_key_in_error(&body_text, &self.api_key) });
                }
                Err(e) => {
                    if attempt < MAX_ATTEMPTS && (e.is_timeout() || e.is_connect()) {
                        backoff(attempt).await;
                        continue;
                    }
                    return Err(OpenAIError::Http(e));
                }
            }
        }
    }
}

async fn backoff(attempt: u32) {
    // 1s, 2s, 4s — capped naturally by MAX_ATTEMPTS = 3.
    let delay_ms = 1000u64 << (attempt - 1).min(3);
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

fn build_request_body(messages: &[ChatMessage], model: Model, stream: bool) -> Json {
    let msgs: Vec<Json> = messages.iter().map(|m| serde_json::json!({
        "role":    role_str(m.role),
        "content": m.content,
    })).collect();
    let mut body = serde_json::json!({
        "model":    model.api_name(),
        "messages": msgs,
        "stream":   stream,
    });
    if stream {
        // Ask OpenAI to include token usage in the FINAL chunk so the
        // budget tracker can record actual spend without falling back
        // to the chars/4 heuristic. Documented under stream_options.
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    body
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::System    => "system",
        Role::User      => "user",
        Role::Assistant => "assistant",
    }
}

/// Best-effort redaction so error bodies bubbled up from the API
/// path don't accidentally embed the key. tracing redaction is the
/// belt-and-suspenders of this crate; this is the suspenders.
fn redact_key_in_error(body: &str, key: &str) -> String {
    if key.is_empty() {
        return body.to_string();
    }
    body.replace(key, "<redacted>")
}

fn resolve_key(store: &Arc<Store>) -> Result<String, OpenAIError> {
    if let Some(byok) = settings::get(store, "openai_byok_key")? {
        if !byok.trim().is_empty() {
            return Ok(byok);
        }
    }
    if let Ok(env_key) = std::env::var(PLATFORM_KEY_ENV) {
        if !env_key.trim().is_empty() {
            return Ok(env_key);
        }
    }
    Err(OpenAIError::NoKey)
}

// ─────────────────────────────────────────────────────────────────────
// SSE parsing (hand-rolled — see module-level docs)
// ─────────────────────────────────────────────────────────────────────

/// Convert a reqwest byte stream into an SSE-aware [`ChatChunk`] stream.
/// Buffers across packet boundaries until a complete `data: ...\n\n`
/// frame is available. Skips `:` heartbeat comments + the literal
/// `data: [DONE]` terminator (we instead synthesize a `Done` chunk
/// from the OpenAI-marked `finish_reason`).
fn sse_chunks(
    bytes: impl Stream<Item = reqwest::Result<bytes::Bytes>> + Send + 'static,
) -> impl Stream<Item = Result<ChatChunk, OpenAIError>> + Send + 'static {
    use futures_util::stream::{self, StreamExt};

    let buf:   Vec<u8> = Vec::new();
    let state = (buf, false /* done_seen */);

    stream::unfold(
        (Box::pin(bytes), state),
        |(mut bytes, (mut buf, mut done_seen))| async move {
            loop {
                // Drain any complete frames already in `buf` first.
                if let Some((emit, next_buf)) = next_frame(&buf) {
                    buf = next_buf;
                    match parse_frame(&emit) {
                        Ok(Some(chunk)) => {
                            if chunk.finish_reason.is_some() { done_seen = true; }
                            return Some((Ok(chunk), (bytes, (buf, done_seen))));
                        }
                        Ok(None) => continue, // [DONE] / ping comment
                        Err(e)   => return Some((Err(e), (bytes, (buf, done_seen)))),
                    }
                }

                // No complete frame buffered — fetch more bytes.
                match bytes.next().await {
                    Some(Ok(packet)) => {
                        buf.extend_from_slice(&packet);
                    }
                    Some(Err(e)) => {
                        return Some((Err(OpenAIError::Http(e)), (bytes, (buf, done_seen))));
                    }
                    None => {
                        // Stream over. Drain a final frame if buffered.
                        if !done_seen {
                            if let Some((emit, _)) = next_frame_or_partial(&buf) {
                                if let Ok(Some(chunk)) = parse_frame(&emit) {
                                    return Some((Ok(chunk), (bytes, (Vec::new(), true))));
                                }
                            }
                        }
                        return None;
                    }
                }
            }
        },
    )
}

/// Pull the first complete `event\n\n` frame from `buf`. Returns the
/// frame body (without the trailing `\n\n`) + the remainder. Returns
/// `None` if no complete frame is buffered.
fn next_frame(buf: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    // Look for `\n\n` (two LFs in a row); we don't need CR support
    // because reqwest 0.12 + axum 0.7 + OpenAI itself emit LF-only.
    for i in 1..buf.len() {
        if buf[i] == b'\n' && buf[i - 1] == b'\n' {
            let frame = buf[..i - 1].to_vec();
            let rest  = buf[i + 1..].to_vec();
            return Some((frame, rest));
        }
    }
    None
}

/// Same as [`next_frame`] but accepts a buffer with a trailing
/// incomplete frame at end-of-stream.
fn next_frame_or_partial(buf: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    if buf.is_empty() {
        return None;
    }
    // Already complete?
    if let Some(frame) = next_frame(buf) {
        return Some(frame);
    }
    // Partial — emit whatever's in buf as the frame; remainder empty.
    Some((buf.to_vec(), Vec::new()))
}

fn parse_frame(frame: &[u8]) -> Result<Option<ChatChunk>, OpenAIError> {
    let s = std::str::from_utf8(frame).map_err(|e| OpenAIError::BadChunk(e.to_string()))?;
    // SSE frames may carry multiple `data:` lines. OpenAI's chat
    // streaming emits exactly one — we only handle that case but
    // tolerate the extra blank line.
    let trimmed = s.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return Ok(None);
    }
    let payload = trimmed
        .strip_prefix("data:")
        .map(str::trim_start)
        .unwrap_or(trimmed);

    if payload == "[DONE]" {
        return Ok(None);
    }

    let parsed: ChunkPayload = serde_json::from_str(payload)
        .map_err(|e| OpenAIError::BadChunk(format!("{}; payload was: {}", e, payload)))?;

    let mut chunk = ChatChunk {
        delta:         String::new(),
        finish_reason: None,
        usage:         None,
    };

    if let Some(choice) = parsed.choices.into_iter().next() {
        chunk.delta = choice.delta.content.unwrap_or_default();
        chunk.finish_reason = choice.finish_reason;
    }
    if let Some(u) = parsed.usage {
        chunk.usage = Some(UsageReport {
            prompt_tokens:     u.prompt_tokens,
            completion_tokens: u.completion_tokens,
        });
    }

    Ok(Some(chunk))
}

// ─────────────────────────────────────────────────────────────────────
// Deserialization shapes — kept private to the module
// ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChunkPayload {
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage:   Option<RawUsage>,
}

#[derive(Deserialize)]
struct ChunkChoice {
    #[serde(default)]
    delta:         ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatCompletion {
    #[serde(default)]
    choices: Vec<CompletionChoice>,
    #[serde(default)]
    usage:   Option<RawUsage>,
    #[serde(default)]
    model:   String,
}

#[derive(Deserialize)]
struct CompletionChoice {
    message: CompletionMessage,
}

#[derive(Deserialize)]
struct CompletionMessage {
    #[serde(default)]
    content: String,
}

#[derive(Default, Deserialize, Serialize, Clone, Copy)]
struct RawUsage {
    #[serde(default)]
    prompt_tokens:     u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_body_includes_stream_options_when_streaming() {
        let msgs = vec![ChatMessage::user("hi")];
        let body = build_request_body(&msgs, Model::Gpt54, true);
        assert_eq!(body["model"], "gpt-5.4");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn build_request_body_omits_stream_options_when_not_streaming() {
        let msgs = vec![ChatMessage::user("hi")];
        let body = build_request_body(&msgs, Model::Gpt4oMini, false);
        assert_eq!(body["stream"], false);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn parse_frame_extracts_delta() {
        let frame = b"data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}";
        let chunk = parse_frame(frame).expect("ok").expect("some");
        assert_eq!(chunk.delta, "Hello");
        assert!(chunk.finish_reason.is_none());
    }

    #[test]
    fn parse_frame_marks_finish_reason() {
        let frame = b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}";
        let chunk = parse_frame(frame).expect("ok").expect("some");
        assert_eq!(chunk.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parse_frame_skips_done_terminator() {
        let frame = b"data: [DONE]";
        let chunk = parse_frame(frame).expect("ok");
        assert!(chunk.is_none());
    }

    #[test]
    fn parse_frame_skips_comment_heartbeat() {
        let frame = b": ping";
        let chunk = parse_frame(frame).expect("ok");
        assert!(chunk.is_none());
    }

    #[test]
    fn next_frame_pulls_one_block_with_remainder() {
        let buf = b"data: a\n\ndata: b\n\n";
        let (frame, rest) = next_frame(buf).unwrap();
        assert_eq!(frame, b"data: a");
        assert_eq!(rest, b"data: b\n\n");
    }

    #[test]
    fn next_frame_returns_none_on_partial_block() {
        let buf = b"data: a";
        assert!(next_frame(buf).is_none());
    }

    #[test]
    fn redacts_key_in_error_body() {
        let body = "auth failed: sk-secret-key";
        let red  = redact_key_in_error(body, "sk-secret-key");
        assert_eq!(red, "auth failed: <redacted>");
    }
}
