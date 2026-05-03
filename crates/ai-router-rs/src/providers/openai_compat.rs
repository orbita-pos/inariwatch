//! OpenAI-compatible chat completions adapter.
//!
//! Used for OpenAI, Grok (api.x.ai), Gemini (generativelanguage), and
//! DeepSeek — same JSON body shape, different base URL and auth header.
//! Mirrors the merged behavior of:
//! - `cli/src/ai/mod.rs::call_openai_compat` (one-shot)
//! - `desktop/src-tauri/src/ai/openai.rs::OpenAIClient::chat_complete /
//!   chat_stream` (one-shot + streaming)
//!
//! ## Lockdown boundary
//!
//! **The provider URL strings (`https://api.openai.com`, etc.) live ONLY
//! in this file (and [`super::anthropic`]).** The integration test
//! `tests/lockdown.rs` enforces that no other Rust source under cli/ or
//! desktop/src-tauri/ contains those strings.

use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::{Stream, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;

use super::types::{AIMessage, AIResponse, AIUsage, ChatChunk};
use crate::rules::AIProvider;

/// Provider error surface. Mirrors the relevant variants of
/// `desktop/src-tauri/src/ai/openai.rs::OpenAIError`. Distinct from
/// [`crate::dispatch::DispatchError`] so adapters can be unit-tested
/// without the dispatch core.
#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("provider returned {status}: {body}")]
    Api { status: u16, body: String },
    #[error("invalid stream chunk: {0}")]
    BadChunk(String),
    #[error("missing API key")]
    NoKey,
}

#[derive(Debug, Clone)]
pub struct OpenAICompatAdapter {
    pub provider: AIProvider,
    pub base_url: String,
    pub api_path: &'static str,
    /// Default model when caller does not specify one.
    pub default_model: &'static str,
}

impl OpenAICompatAdapter {
    /// Build an adapter for the four OpenAI-compatible providers we
    /// support today. Routes the lockdown URLs to a single source.
    pub fn for_provider(provider: AIProvider) -> Self {
        match provider {
            AIProvider::Openai => OpenAICompatAdapter {
                provider,
                base_url: "https://api.openai.com".to_string(),
                api_path: "/v1/chat/completions",
                default_model: "gpt-4o-mini",
            },
            AIProvider::Grok => OpenAICompatAdapter {
                provider,
                base_url: "https://api.x.ai".to_string(),
                api_path: "/v1/chat/completions",
                default_model: "grok-3-mini-beta",
            },
            AIProvider::Gemini => OpenAICompatAdapter {
                provider,
                base_url: "https://generativelanguage.googleapis.com".to_string(),
                // OpenAI-compatible endpoint exposed under /v1beta/openai.
                api_path: "/v1beta/openai/chat/completions",
                default_model: "gemini-2.0-flash",
            },
            AIProvider::Deepseek => OpenAICompatAdapter {
                provider,
                base_url: "https://api.deepseek.com".to_string(),
                api_path: "/v1/chat/completions",
                default_model: "deepseek-chat",
            },
            AIProvider::Groq => OpenAICompatAdapter {
                provider,
                base_url: "https://api.groq.com".to_string(),
                api_path: "/openai/v1/chat/completions",
                default_model: "llama-3.1-8b-instant",
            },
            AIProvider::Claude => panic!(
                "Claude is not OpenAI-compatible — use AnthropicAdapter instead"
            ),
        }
    }

    /// Override the base URL so callers can point the adapter at a
    /// mock server. Reachable from production code via
    /// [`crate::dispatch::DispatchInput::base_url_override`] — production
    /// callers leave that `None` and the adapter keeps its pinned
    /// provider URL. The lockdown still holds: no provider URL strings
    /// appear outside this module.
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    fn url(&self) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), self.api_path)
    }

    /// One-shot non-streaming completion.
    pub async fn complete(
        &self,
        api_key: &str,
        system_prompt: &str,
        messages: &[AIMessage],
        model: Option<&str>,
        max_tokens: u32,
        temperature: Option<f32>,
        timeout: Option<Duration>,
        json_mode: bool,
    ) -> Result<AIResponse, ProviderError> {
        if api_key.is_empty() {
            return Err(ProviderError::NoKey);
        }
        let body = build_body(
            system_prompt,
            messages,
            model.unwrap_or(self.default_model),
            max_tokens,
            temperature,
            false,
            json_mode,
        );

        let client = build_client(timeout)?;
        let resp = client
            .post(self.url())
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api {
                status,
                body: redact(&body, api_key),
            });
        }

        let parsed: ChatCompletion = resp.json().await?;
        let model_used = parsed.model.clone();
        let text = parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content.unwrap_or_default())
            .unwrap_or_default();
        let usage = parsed.usage.map(into_ai_usage).unwrap_or_default();

        Ok(AIResponse {
            text,
            usage,
            model: model_used,
            provider: self.provider,
        })
    }

    /// SSE streaming completion. Returns a stream of [`ChatChunk`]s. The
    /// terminal chunk carries `finish_reason: Some(_)` and (when the
    /// provider supports it) `usage`.
    ///
    /// Hand-rolled SSE parsing matches the desktop S18 implementation —
    /// frame separator is `\n\n`, terminator is `data: [DONE]`, comments
    /// (`:` lines) are skipped.
    pub async fn stream_complete(
        &self,
        api_key: &str,
        system_prompt: &str,
        messages: &[AIMessage],
        model: Option<&str>,
        max_tokens: u32,
        temperature: Option<f32>,
        timeout: Option<Duration>,
    ) -> Result<
        std::pin::Pin<Box<dyn Stream<Item = Result<ChatChunk, ProviderError>> + Send>>,
        ProviderError,
    > {
        if api_key.is_empty() {
            return Err(ProviderError::NoKey);
        }
        let body = build_body(
            system_prompt,
            messages,
            model.unwrap_or(self.default_model),
            max_tokens,
            temperature,
            true,
            false,
        );

        let client = build_client(timeout)?;
        let resp = client
            .post(self.url())
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api {
                status,
                body: redact(&body, api_key),
            });
        }

        let bytes_stream = resp.bytes_stream();
        Ok(Box::pin(sse_chunks(bytes_stream)))
    }
}

fn build_client(timeout: Option<Duration>) -> Result<Client, ProviderError> {
    let mut builder = reqwest::Client::builder();
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    } else {
        builder = builder.timeout(Duration::from_secs(60));
    }
    builder.build().map_err(ProviderError::Http)
}

fn build_body(
    system_prompt: &str,
    messages: &[AIMessage],
    model: &str,
    max_tokens: u32,
    temperature: Option<f32>,
    stream: bool,
    json_mode: bool,
) -> Value {
    let mut msgs: Vec<Value> = Vec::with_capacity(messages.len() + 1);
    if !system_prompt.is_empty() {
        msgs.push(json!({ "role": "system", "content": system_prompt }));
    }
    for m in messages {
        msgs.push(json!({ "role": m.role.as_str(), "content": m.content }));
    }
    let mut body = json!({
        "model": model,
        "messages": msgs,
        "max_tokens": max_tokens,
        "stream": stream,
    });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if stream {
        // OpenAI-style: ask the provider to emit usage in the terminal
        // SSE chunk. Providers that ignore the option still stream
        // tokens; usage just stays None.
        body["stream_options"] = json!({ "include_usage": true });
    }
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    body
}

fn redact(body: &str, key: &str) -> String {
    if key.is_empty() {
        return body.to_string();
    }
    body.replace(key, "<redacted>")
}

// ── SSE parsing ───────────────────────────────────────────────────────────

fn sse_chunks(
    bytes: impl Stream<Item = reqwest::Result<Bytes>> + Send + 'static,
) -> impl Stream<Item = Result<ChatChunk, ProviderError>> + Send + 'static {
    use futures_util::stream;
    let buf: Vec<u8> = Vec::new();
    let state = (buf, false);

    stream::unfold(
        (Box::pin(bytes), state),
        |(mut bytes, (mut buf, mut done_seen))| async move {
            loop {
                if let Some((emit, next_buf)) = next_frame(&buf) {
                    buf = next_buf;
                    match parse_frame(&emit) {
                        Ok(Some(chunk)) => {
                            if chunk.finish_reason.is_some() {
                                done_seen = true;
                            }
                            return Some((Ok(chunk), (bytes, (buf, done_seen))));
                        }
                        Ok(None) => continue,
                        Err(e) => return Some((Err(e), (bytes, (buf, done_seen)))),
                    }
                }
                match bytes.next().await {
                    Some(Ok(packet)) => buf.extend_from_slice(&packet),
                    Some(Err(e)) => {
                        return Some((Err(ProviderError::Http(e)), (bytes, (buf, done_seen))));
                    }
                    None => {
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

fn next_frame(buf: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    for i in 1..buf.len() {
        if buf[i] == b'\n' && buf[i - 1] == b'\n' {
            let frame = buf[..i - 1].to_vec();
            let rest = buf[i + 1..].to_vec();
            return Some((frame, rest));
        }
    }
    None
}

fn next_frame_or_partial(buf: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    if buf.is_empty() {
        return None;
    }
    if let Some(frame) = next_frame(buf) {
        return Some(frame);
    }
    Some((buf.to_vec(), Vec::new()))
}

fn parse_frame(frame: &[u8]) -> Result<Option<ChatChunk>, ProviderError> {
    let s = std::str::from_utf8(frame).map_err(|e| ProviderError::BadChunk(e.to_string()))?;
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

    let parsed: ChunkPayload = serde_json::from_str(payload).map_err(|e| {
        ProviderError::BadChunk(format!("{e}; payload was: {payload}"))
    })?;

    let mut chunk = ChatChunk::default();
    if let Some(choice) = parsed.choices.into_iter().next() {
        chunk.delta = choice.delta.content.unwrap_or_default();
        chunk.finish_reason = choice.finish_reason;
    }
    if let Some(u) = parsed.usage {
        chunk.usage = Some(into_ai_usage(u));
    }
    Ok(Some(chunk))
}

fn into_ai_usage(u: RawUsage) -> AIUsage {
    AIUsage {
        input_tokens: u.prompt_tokens.unwrap_or(0) as i64,
        output_tokens: u.completion_tokens.unwrap_or(0) as i64,
        cached_input_tokens: u
            .prompt_tokens_details
            .and_then(|d| d.cached_tokens)
            .unwrap_or(0) as i64,
    }
}

// ── Wire types ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChatCompletion {
    #[serde(default)]
    choices: Vec<CompletionChoice>,
    #[serde(default)]
    usage: Option<RawUsage>,
    #[serde(default)]
    model: String,
}

#[derive(Deserialize)]
struct CompletionChoice {
    message: CompletionMessage,
}

#[derive(Deserialize)]
struct CompletionMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChunkPayload {
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct ChunkChoice {
    #[serde(default)]
    delta: ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct RawUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_body_includes_system_prompt_first() {
        let body = build_body(
            "be terse",
            &[AIMessage::user("hi")],
            "gpt-4o-mini",
            256,
            None,
            false,
            false,
        );
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "be terse");
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn build_body_streaming_adds_usage_option() {
        let body = build_body("", &[AIMessage::user("hi")], "x", 64, None, true, false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn build_body_skips_empty_system_prompt() {
        let body = build_body("", &[AIMessage::user("hi")], "x", 64, None, false, false);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }

    #[test]
    fn build_body_includes_temperature_when_set() {
        let body = build_body("s", &[AIMessage::user("u")], "x", 64, Some(0.2), false, false);
        // `f32` round-trips through serde_json as f64 with rounding
        // error in the 7th significant digit. Compare with tolerance
        // rather than equality.
        let t = body["temperature"].as_f64().expect("number");
        assert!((t - 0.2).abs() < 1e-3, "got {t}");
    }

    #[test]
    fn build_body_json_mode_sets_response_format() {
        let body = build_body("s", &[AIMessage::user("u")], "x", 64, None, false, true);
        assert_eq!(body["response_format"]["type"], "json_object");
    }

    #[test]
    fn parse_frame_extracts_delta() {
        let frame = b"data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}";
        let chunk = parse_frame(frame).unwrap().unwrap();
        assert_eq!(chunk.delta, "Hello");
        assert!(chunk.finish_reason.is_none());
    }

    #[test]
    fn parse_frame_marks_finish_reason() {
        let frame = b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}";
        let chunk = parse_frame(frame).unwrap().unwrap();
        assert_eq!(chunk.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parse_frame_skips_done_terminator() {
        let frame = b"data: [DONE]";
        assert!(parse_frame(frame).unwrap().is_none());
    }

    #[test]
    fn parse_frame_skips_comments() {
        let frame = b": ping";
        assert!(parse_frame(frame).unwrap().is_none());
    }

    #[test]
    fn next_frame_pulls_one_block_with_remainder() {
        let buf = b"data: a\n\ndata: b\n\n";
        let (frame, rest) = next_frame(buf).unwrap();
        assert_eq!(frame, b"data: a");
        assert_eq!(rest, b"data: b\n\n");
    }

    #[test]
    fn redact_replaces_key_in_error_body() {
        assert_eq!(
            redact("auth failed: sk-secret", "sk-secret"),
            "auth failed: <redacted>",
        );
    }

    #[test]
    fn for_provider_pins_url_per_provider() {
        let openai = OpenAICompatAdapter::for_provider(AIProvider::Openai);
        assert_eq!(openai.base_url, "https://api.openai.com");
        assert_eq!(openai.api_path, "/v1/chat/completions");

        let grok = OpenAICompatAdapter::for_provider(AIProvider::Grok);
        assert_eq!(grok.base_url, "https://api.x.ai");

        let gemini = OpenAICompatAdapter::for_provider(AIProvider::Gemini);
        assert_eq!(gemini.base_url, "https://generativelanguage.googleapis.com");

        let deepseek = OpenAICompatAdapter::for_provider(AIProvider::Deepseek);
        assert_eq!(deepseek.base_url, "https://api.deepseek.com");

        let groq = OpenAICompatAdapter::for_provider(AIProvider::Groq);
        assert_eq!(groq.base_url, "https://api.groq.com");
    }

    #[test]
    #[should_panic(expected = "not OpenAI-compatible")]
    fn for_provider_panics_on_claude() {
        let _ = OpenAICompatAdapter::for_provider(AIProvider::Claude);
    }

    #[tokio::test]
    async fn complete_round_trips_against_mockito() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/v1/chat/completions")
            .match_header("authorization", "Bearer test-key")
            .with_status(200)
            .with_body(
                r#"{"choices":[{"message":{"content":"hi back"}}],"usage":{"prompt_tokens":10,"completion_tokens":3},"model":"gpt-4o-mini"}"#,
            )
            .create_async()
            .await;

        let adapter = OpenAICompatAdapter::for_provider(AIProvider::Openai)
            .with_base_url(server.url());
        let resp = adapter
            .complete(
                "test-key",
                "be terse",
                &[AIMessage::user("hi")],
                None,
                256,
                None,
                Some(Duration::from_secs(5)),
                false,
            )
            .await
            .expect("complete");
        assert_eq!(resp.text, "hi back");
        assert_eq!(resp.usage.input_tokens, 10);
        assert_eq!(resp.usage.output_tokens, 3);
        assert_eq!(resp.model, "gpt-4o-mini");
        m.assert_async().await;
    }

    #[tokio::test]
    async fn complete_propagates_api_error_with_redacted_body() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/chat/completions")
            .with_status(401)
            .with_body("invalid key: secret-key-here")
            .create_async()
            .await;

        let adapter = OpenAICompatAdapter::for_provider(AIProvider::Openai)
            .with_base_url(server.url());
        let err = adapter
            .complete(
                "secret-key-here",
                "",
                &[AIMessage::user("hi")],
                None,
                64,
                None,
                Some(Duration::from_secs(2)),
                false,
            )
            .await
            .unwrap_err();
        match err {
            ProviderError::Api { status, body } => {
                assert_eq!(status, 401);
                assert!(body.contains("<redacted>"), "expected redacted, got: {body}");
                assert!(!body.contains("secret-key-here"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn complete_rejects_empty_key_before_io() {
        let adapter = OpenAICompatAdapter::for_provider(AIProvider::Openai);
        let err = adapter
            .complete("", "", &[AIMessage::user("hi")], None, 64, None, None, false)
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::NoKey));
    }
}
