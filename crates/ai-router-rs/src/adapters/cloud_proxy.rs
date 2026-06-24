//! Cloud-substrate adapter with dual-mode dispatch.
//!
//! Per Jesus's S7 directive (2026-05-02): the lockdown is satisfied not
//! just by URL string boundaries but by **the actual HTTP call going
//! through one router**. Two modes coexist:
//!
//! 1. **Direct mode** — Rust caller has a BYOK / platform key in hand
//!    and `INARI_AI_DIRECT=true` (or no proxy is configured). We pick a
//!    provider, instantiate the matching adapter from
//!    [`crate::providers`], and issue the HTTP call. Provider URLs live
//!    only inside [`crate::providers::openai_compat`] and
//!    [`crate::providers::anthropic`] — the lockdown integration test
//!    enforces this.
//!
//! 2. **Proxy mode** — `INARI_WEB_URL` + `INARI_WEB_TOKEN` env vars are
//!    set. We POST the dispatch payload to `<url>/api/ai/dispatch`,
//!    which authenticates with Bearer and forwards into web's TS
//!    `dispatch()`. Web resolves the actual provider key + budget.
//!
//! ## Mode selection precedence
//!
//! | Condition                                     | Mode    |
//! |-----------------------------------------------|---------|
//! | `INARI_AI_DIRECT=true` (or `=1`)              | Direct  |
//! | `INARI_WEB_URL` + `INARI_WEB_TOKEN` both set  | Proxy   |
//! | otherwise                                     | Direct  |
//!
//! CLI standalone with BYOK lands in the Direct branch (no env vars set
//! in `~/.inariwatch/config.toml`-driven flows). Cloud-authed Inari
//! Live + future cloud-authed CLI land in Proxy after Phase 1 of v0.4
//! wires the device-flow auth.

use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::providers::anthropic::AnthropicAdapter;
use crate::providers::openai_compat::{OpenAICompatAdapter, ProviderError};
use crate::providers::types::{AIMessage, AIResponse, AITool, AIUsage, ChatChunk, ToolCallDelta};
use crate::rules::{detect_provider, AIProvider, Target};
use crate::tasks::TaskName;

/// What the Rust caller passes to [`run_complete`] / [`run_stream`].
/// Mirrors the "complete" branch of [`crate::dispatch::DispatchInput`]
/// minus the workspace plumbing (which is the dispatch core's job).
#[derive(Debug, Clone)]
pub struct CloudCallInput<'a> {
    pub task: TaskName,
    pub api_key: &'a str,
    pub system_prompt: &'a str,
    pub messages: &'a [AIMessage],
    pub model: Option<&'a str>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub timeout: Option<Duration>,
    pub json_mode: bool,
    /// Caller-supplied provider override. Wins over rule hints +
    /// `detect_provider`. Mirrors the TS `pickProvider` precedence.
    pub provider_override: Option<AIProvider>,
    /// Test-only host override. When `Some`, direct-mode adapters point
    /// their HTTP calls at this URL instead of the pinned provider URL
    /// (`https://api.openai.com`, etc.). Surfaces use this from
    /// `OpenAIClient::with_base_url(...)` to wire mockito fixtures.
    /// Lockdown stays intact — no provider URL leaks outside this crate.
    pub base_url_override: Option<&'a str>,
    /// S6 — chat-agent tool catalog. Empty slice means "no tool use",
    /// preserving every existing call site. Direct-mode OpenAI
    /// streaming forwards the catalog into the request body; the proxy
    /// path now also forwards it as `tools[]` on the wire (paired with
    /// the S6.5 server-side wiring in `/api/ai/dispatch`).
    pub tools: &'a [AITool],
}

/// Errors surfaced from the cloud adapter. Distinguishes proxy-side
/// failures (HTTP / auth) from direct-side failures (provider 4xx/5xx)
/// so the dispatch core's [`crate::dispatch::should_fallback`] can map
/// to the right [`crate::rules::FallbackTrigger`].
#[derive(Debug, Error)]
pub enum CloudError {
    #[error("provider: {0}")]
    Provider(#[from] ProviderError),
    #[error("proxy HTTP error: {0}")]
    ProxyHttp(reqwest::Error),
    #[error("proxy returned {status}: {body}")]
    ProxyApi { status: u16, body: String },
    #[error("proxy response parse: {0}")]
    ProxyParse(String),
    #[error("no provider could be resolved")]
    NoProvider,
}

impl CloudError {
    /// Identify HTTP-status-bearing errors so the dispatch core can map
    /// to `cloud-error` / `cloud-rate-limit` triggers.
    pub fn http_status(&self) -> Option<u16> {
        match self {
            CloudError::Provider(ProviderError::Api { status, .. }) => Some(*status),
            CloudError::ProxyApi { status, .. } => Some(*status),
            _ => None,
        }
    }
}

/// Dual-mode resolver. Visible for tests and for the dispatch core.
#[derive(Debug, Clone)]
pub enum CloudMode {
    Direct,
    Proxy { url: String, token: String },
}

impl CloudMode {
    /// Resolve the active mode from environment variables. Pure;
    /// callers may pass an explicit [`CloudMode`] in tests.
    pub fn from_env() -> CloudMode {
        if let Ok(v) = std::env::var("INARI_AI_DIRECT") {
            if v == "true" || v == "1" {
                return CloudMode::Direct;
            }
        }
        let url = std::env::var("INARI_WEB_URL").unwrap_or_default();
        let token = std::env::var("INARI_WEB_TOKEN").unwrap_or_default();
        if !url.is_empty() && !token.is_empty() {
            return CloudMode::Proxy { url, token };
        }
        CloudMode::Direct
    }
}

/// Pick the effective provider for a direct call. Mirrors the TS
/// `pickProvider` order: caller-explicit > apiKey-prefix > rule hint >
/// `openai` default.
fn pick_direct_provider(
    input: &CloudCallInput<'_>,
    target: &Target,
) -> AIProvider {
    if let Some(p) = input.provider_override {
        return p;
    }
    let detected = detect_provider(input.api_key);
    if detected != AIProvider::Openai {
        return detected;
    }
    if let Target::Cloud {
        provider: Some(p), ..
    } = target
    {
        return *p;
    }
    detected
}

// ── Wire shape for proxy mode ─────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ProxyCompleteRequest<'a> {
    task: &'a str,
    mode: &'static str,
    system_prompt: &'a str,
    messages: Vec<ProxyMessage<'a>>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    json_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'a str>,
    /// BYOK pass-through — when the caller has a workspace-bound key,
    /// the proxy honors it. Web-side dispatch already handles
    /// `apiKey` in the same shape (see `packages/ai-router/src/dispatch.ts`).
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<&'a str>,
    /// S6.5 — function-calling catalog. Honored by the streaming path
    /// (mode="stream") only today. Field is omitted when the caller's
    /// `input.tools` is empty so providers that 400 on an empty `tools`
    /// array (Groq) stay happy.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<ProxyToolDef<'a>>,
}

#[derive(Debug, Serialize)]
struct ProxyMessage<'a> {
    role: &'static str,
    content: &'a str,
}

/// Wire shape of one tool entry forwarded through `/api/ai/dispatch`.
/// Mirrors the TS `ToolDefinition` interface: `{ name, description,
/// input_schema }`. We borrow from [`AITool`] in [`CloudCallInput::tools`]
/// — Rust's field name is `parameters` but the TS server keys on
/// `input_schema`, so the rename happens here at the wire boundary.
#[derive(Debug, Serialize)]
struct ProxyToolDef<'a> {
    name: &'a str,
    description: &'a str,
    input_schema: &'a Value,
}

#[derive(Debug, Deserialize)]
struct ProxyCompleteResponse {
    text: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    usage: Option<ProxyUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct ProxyUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cached_input_tokens: i64,
}

// ── Public entry points ───────────────────────────────────────────────────

pub async fn run_complete(
    input: CloudCallInput<'_>,
    target: &Target,
    mode: &CloudMode,
) -> Result<AIResponse, CloudError> {
    match mode {
        CloudMode::Direct => run_complete_direct(input, target).await,
        CloudMode::Proxy { url, token } => run_complete_proxy(input, url, token).await,
    }
}

pub async fn run_stream(
    input: CloudCallInput<'_>,
    target: &Target,
    mode: &CloudMode,
) -> Result<
    std::pin::Pin<Box<dyn Stream<Item = Result<ChatChunk, CloudError>> + Send>>,
    CloudError,
> {
    match mode {
        CloudMode::Direct => run_stream_direct(input, target).await,
        CloudMode::Proxy { url, token } => run_stream_proxy(input, url, token).await,
    }
}

// ── Direct mode ───────────────────────────────────────────────────────────

async fn run_complete_direct(
    input: CloudCallInput<'_>,
    target: &Target,
) -> Result<AIResponse, CloudError> {
    let provider = pick_direct_provider(&input, target);
    match provider {
        AIProvider::Claude => {
            let mut adapter = AnthropicAdapter::default();
            if let Some(url) = input.base_url_override {
                adapter = adapter.with_base_url(url);
            }
            adapter
                .complete(
                    input.api_key,
                    input.system_prompt,
                    input.messages,
                    input.model,
                    input.max_tokens,
                    input.temperature,
                    input.timeout,
                )
                .await
                .map_err(CloudError::Provider)
        }
        other => {
            let mut adapter = OpenAICompatAdapter::for_provider(other);
            if let Some(url) = input.base_url_override {
                adapter = adapter.with_base_url(url);
            }
            adapter
                .complete(
                    input.api_key,
                    input.system_prompt,
                    input.messages,
                    input.model,
                    input.max_tokens,
                    input.temperature,
                    input.timeout,
                    input.json_mode,
                )
                .await
                .map_err(CloudError::Provider)
        }
    }
}

async fn run_stream_direct(
    input: CloudCallInput<'_>,
    target: &Target,
) -> Result<
    std::pin::Pin<Box<dyn Stream<Item = Result<ChatChunk, CloudError>> + Send>>,
    CloudError,
> {
    let provider = pick_direct_provider(&input, target);
    if provider == AIProvider::Claude {
        // Anthropic streaming is wire-incompatible with OpenAI SSE
        // (separate `event:` lines per delta). Today neither cli/ nor
        // desktop/ stream from Claude; we surface a clean error so
        // callers fall back to non-streaming complete or another
        // provider. v0.4 may add Claude streaming when a surface
        // demands it.
        return Err(CloudError::Provider(ProviderError::BadChunk(
            "stream-not-supported: Claude streaming not wired in v0.3".to_string(),
        )));
    }
    let mut adapter = OpenAICompatAdapter::for_provider(provider);
    if let Some(url) = input.base_url_override {
        adapter = adapter.with_base_url(url);
    }
    let inner = adapter
        .stream_complete(
            input.api_key,
            input.system_prompt,
            input.messages,
            input.model,
            input.max_tokens,
            input.temperature,
            input.timeout,
            input.tools,
        )
        .await
        .map_err(CloudError::Provider)?;
    Ok(Box::pin(inner.map(|r| r.map_err(CloudError::Provider))))
}

// ── Proxy mode ────────────────────────────────────────────────────────────

fn build_proxy_request<'a>(
    input: &'a CloudCallInput<'a>,
    mode: &'static str,
) -> ProxyCompleteRequest<'a> {
    ProxyCompleteRequest {
        task: input.task.as_str(),
        mode,
        system_prompt: input.system_prompt,
        messages: input
            .messages
            .iter()
            .map(|m| ProxyMessage {
                role: m.role.as_str(),
                content: &m.content,
            })
            .collect(),
        max_tokens: input.max_tokens,
        model: input.model,
        temperature: input.temperature,
        json_mode: if input.json_mode { Some(true) } else { None },
        provider: input.provider_override.map(|p| p.as_str()),
        // Propagate the BYOK key only when caller has one. Web-side
        // dispatch falls back to the user's stored key if api_key is
        // absent.
        api_key: if input.api_key.is_empty() {
            None
        } else {
            Some(input.api_key)
        },
        // Map Rust's `AITool.parameters` → TS's `ToolDefinition.input_schema`.
        // The borrow keeps the `Value` heap allocation owned by the
        // caller's `CloudCallInput`; serde walks it in-place when
        // serializing.
        tools: input
            .tools
            .iter()
            .map(|t| ProxyToolDef {
                name: t.name.as_str(),
                description: t.description.as_str(),
                input_schema: &t.parameters,
            })
            .collect(),
    }
}

fn build_proxy_url(base: &str, _suffix: &str) -> String {
    // Single endpoint discriminated by `body.mode`. We previously
    // varied the URL (`/api/ai/dispatch/stream`) but the route handler
    // already inspects `mode` to decide between JSON and SSE response —
    // a separate URL adds noise without value. The `_suffix` parameter
    // is retained so existing call sites compile without churn.
    format!("{}/api/ai/dispatch", base.trim_end_matches('/'))
}

async fn run_complete_proxy(
    input: CloudCallInput<'_>,
    base_url: &str,
    token: &str,
) -> Result<AIResponse, CloudError> {
    let body = build_proxy_request(&input, "complete");
    let mut builder = reqwest::Client::builder();
    builder = builder.timeout(input.timeout.unwrap_or(Duration::from_secs(60)));
    let client = builder.build().map_err(CloudError::ProxyHttp)?;

    let resp = client
        .post(build_proxy_url(base_url, ""))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(CloudError::ProxyHttp)?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(CloudError::ProxyApi { status, body });
    }

    let parsed: ProxyCompleteResponse = resp
        .json()
        .await
        .map_err(|e| CloudError::ProxyParse(e.to_string()))?;

    let usage = parsed.usage.unwrap_or_default();
    let provider = parsed
        .provider
        .as_deref()
        .map(parse_provider)
        .unwrap_or(AIProvider::Openai);

    Ok(AIResponse {
        text: parsed.text,
        usage: AIUsage {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cached_input_tokens: usage.cached_input_tokens,
        },
        model: parsed.model.unwrap_or_default(),
        provider,
    })
}

async fn run_stream_proxy(
    input: CloudCallInput<'_>,
    base_url: &str,
    token: &str,
) -> Result<
    std::pin::Pin<Box<dyn Stream<Item = Result<ChatChunk, CloudError>> + Send>>,
    CloudError,
> {
    let body = build_proxy_request(&input, "stream");
    let mut builder = reqwest::Client::builder();
    builder = builder.timeout(input.timeout.unwrap_or(Duration::from_secs(20 * 60)));
    let client = builder.build().map_err(CloudError::ProxyHttp)?;

    let resp = client
        .post(build_proxy_url(base_url, "/stream"))
        .bearer_auth(token)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(CloudError::ProxyHttp)?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(CloudError::ProxyApi { status, body });
    }

    let bytes = resp.bytes_stream();
    Ok(Box::pin(parse_proxy_sse(bytes)))
}

fn parse_proxy_sse(
    bytes: impl Stream<Item = reqwest::Result<Bytes>> + Send + 'static,
) -> impl Stream<Item = Result<ChatChunk, CloudError>> + Send + 'static {
    use futures_util::stream;
    let buf: Vec<u8> = Vec::new();
    let state = (buf, false);
    stream::unfold(
        (Box::pin(bytes), state),
        |(mut bytes, (mut buf, mut done_seen))| async move {
            loop {
                if let Some((emit, next_buf)) = next_frame(&buf) {
                    buf = next_buf;
                    match parse_proxy_frame(&emit) {
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
                        return Some((Err(CloudError::ProxyHttp(e)), (bytes, (buf, done_seen))));
                    }
                    None => return None,
                }
            }
        },
    )
}

fn next_frame(buf: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    for i in 1..buf.len() {
        if buf[i] == b'\n' && buf[i - 1] == b'\n' {
            return Some((buf[..i - 1].to_vec(), buf[i + 1..].to_vec()));
        }
    }
    None
}

fn parse_proxy_frame(frame: &[u8]) -> Result<Option<ChatChunk>, CloudError> {
    let s = std::str::from_utf8(frame)
        .map_err(|e| CloudError::ProxyParse(e.to_string()))?;
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
    // The proxy emits four chunk shapes:
    //   - text delta:     {"delta": "tok", "done": false}
    //   - tool-call delta:{"delta": "", "done": false, "tool_call": {...}}
    //   - terminal:       {"delta": "", "done": true, "finish_reason": "stop"|"tool_calls",
    //                      "usage": {...}, "model": "..."}
    //   - error frame:    handled by the surrounding stream wrapper.
    // Field names mirror the Rust [`ToolCallDelta`] shape so the parse is
    // direct.
    let parsed: Value = serde_json::from_str(payload)
        .map_err(|e| CloudError::ProxyParse(e.to_string()))?;
    let delta = parsed
        .get("delta")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let done = parsed.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut chunk = ChatChunk {
        delta,
        finish_reason: None,
        usage: None,
        tool_call: None,
    };
    if let Some(tc) = parsed.get("tool_call") {
        // Best-effort deserialize. Bad payloads drop the tool_call
        // silently so a misformed frame doesn't kill the whole stream;
        // the rest of the chunk (text delta, etc.) still flows.
        if let Ok(td) = serde_json::from_value::<ToolCallDelta>(tc.clone()) {
            chunk.tool_call = Some(td);
        }
    }
    if done {
        // Honor the server's `finish_reason` when present so the
        // streaming accumulator (`stream_to_bus` in desktop) can route
        // `tool_calls` closures correctly. Older servers omitted the
        // field; default to "stop" for back-compat.
        let reason = parsed
            .get("finish_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("stop")
            .to_string();
        chunk.finish_reason = Some(reason);
        if let Some(u) = parsed.get("usage") {
            let input = u.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let output = u.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let cached = u
                .get("cached_input_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            chunk.usage = Some(AIUsage {
                input_tokens: input,
                output_tokens: output,
                cached_input_tokens: cached,
            });
        }
    }
    Ok(Some(chunk))
}

fn parse_provider(s: &str) -> AIProvider {
    match s {
        "claude" => AIProvider::Claude,
        "groq" => AIProvider::Groq,
        "grok" => AIProvider::Grok,
        "deepseek" => AIProvider::Deepseek,
        "gemini" => AIProvider::Gemini,
        "together" => AIProvider::Together,
        _ => AIProvider::Openai,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(key: &'a str) -> CloudCallInput<'a> {
        CloudCallInput {
            task: TaskName::AlertAutoAnalyze,
            api_key: key,
            system_prompt: "be terse",
            messages: &[],
            model: None,
            max_tokens: 128,
            temperature: None,
            timeout: Some(Duration::from_secs(2)),
            json_mode: false,
            provider_override: None,
            base_url_override: None,
            tools: &[],
        }
    }

    #[test]
    fn pick_direct_provider_honors_caller_override() {
        let i = CloudCallInput {
            provider_override: Some(AIProvider::Grok),
            ..input("sk-foo")
        };
        let target = Target::Cloud {
            provider: Some(AIProvider::Openai),
            model: None,
        };
        assert_eq!(pick_direct_provider(&i, &target), AIProvider::Grok);
    }

    #[test]
    fn pick_direct_provider_detects_anthropic_from_key_prefix() {
        let i = input("sk-ant-secret");
        let target = Target::Cloud {
            provider: None,
            model: None,
        };
        assert_eq!(pick_direct_provider(&i, &target), AIProvider::Claude);
    }

    #[test]
    fn pick_direct_provider_falls_back_to_target_hint() {
        let i = input("sk-generic");
        let target = Target::Cloud {
            provider: Some(AIProvider::Groq),
            model: None,
        };
        assert_eq!(pick_direct_provider(&i, &target), AIProvider::Groq);
    }

    #[test]
    fn pick_direct_provider_defaults_to_openai() {
        let i = input("sk-anything");
        let target = Target::Cloud {
            provider: None,
            model: None,
        };
        assert_eq!(pick_direct_provider(&i, &target), AIProvider::Openai);
    }

    #[test]
    fn cloud_mode_from_env_prefers_direct_when_flag_set() {
        // Env-var manipulation is ambient state; we restore on drop.
        struct EnvGuard;
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                std::env::remove_var("INARI_AI_DIRECT");
                std::env::remove_var("INARI_WEB_URL");
                std::env::remove_var("INARI_WEB_TOKEN");
            }
        }
        let _g = EnvGuard;

        std::env::set_var("INARI_AI_DIRECT", "true");
        std::env::set_var("INARI_WEB_URL", "https://example.com");
        std::env::set_var("INARI_WEB_TOKEN", "token");
        match CloudMode::from_env() {
            CloudMode::Direct => {}
            other => panic!("expected Direct, got {:?}", other),
        }
    }

    #[test]
    fn cloud_mode_from_env_uses_proxy_when_url_and_token_set() {
        struct EnvGuard;
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                std::env::remove_var("INARI_AI_DIRECT");
                std::env::remove_var("INARI_WEB_URL");
                std::env::remove_var("INARI_WEB_TOKEN");
            }
        }
        let _g = EnvGuard;
        std::env::remove_var("INARI_AI_DIRECT");
        std::env::set_var("INARI_WEB_URL", "https://example.com");
        std::env::set_var("INARI_WEB_TOKEN", "token");
        match CloudMode::from_env() {
            CloudMode::Proxy { url, token } => {
                assert_eq!(url, "https://example.com");
                assert_eq!(token, "token");
            }
            other => panic!("expected Proxy, got {:?}", other),
        }
    }

    #[test]
    fn build_proxy_url_returns_single_endpoint_regardless_of_suffix() {
        assert_eq!(
            build_proxy_url("https://app.inariwatch.com/", ""),
            "https://app.inariwatch.com/api/ai/dispatch",
        );
        assert_eq!(
            build_proxy_url("https://app.inariwatch.com", "/stream"),
            "https://app.inariwatch.com/api/ai/dispatch",
        );
    }

    #[test]
    fn build_proxy_request_skips_empty_api_key() {
        let i = input("");
        let req = build_proxy_request(&i, "complete");
        assert!(req.api_key.is_none());
    }

    #[test]
    fn build_proxy_request_passes_through_byok_key() {
        let i = input("sk-byok");
        let req = build_proxy_request(&i, "complete");
        assert_eq!(req.api_key, Some("sk-byok"));
    }

    #[tokio::test]
    async fn proxy_complete_round_trips_against_mockito() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/api/ai/dispatch")
            .match_header("authorization", "Bearer t-tok")
            .with_status(200)
            .with_body(
                r#"{"text":"ok","model":"gpt-4o-mini","provider":"openai","usage":{"input_tokens":2,"output_tokens":1,"cached_input_tokens":0}}"#,
            )
            .create_async()
            .await;
        let i = input("");
        let resp = run_complete_proxy(i, &server.url(), "t-tok")
            .await
            .expect("ok");
        assert_eq!(resp.text, "ok");
        assert_eq!(resp.model, "gpt-4o-mini");
        assert_eq!(resp.provider, AIProvider::Openai);
        assert_eq!(resp.usage.input_tokens, 2);
        m.assert_async().await;
    }

    #[tokio::test]
    async fn proxy_complete_propagates_api_error() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/api/ai/dispatch")
            .with_status(429)
            .with_body("rate limited")
            .create_async()
            .await;
        let i = input("");
        let err = run_complete_proxy(i, &server.url(), "t")
            .await
            .unwrap_err();
        match err {
            CloudError::ProxyApi { status, body } => {
                assert_eq!(status, 429);
                assert!(body.contains("rate limited"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn cloud_error_http_status_classifies_provider_and_proxy_errors() {
        let pe = CloudError::Provider(ProviderError::Api {
            status: 500,
            body: "x".to_string(),
        });
        assert_eq!(pe.http_status(), Some(500));
        let pa = CloudError::ProxyApi {
            status: 429,
            body: "y".to_string(),
        };
        assert_eq!(pa.http_status(), Some(429));
        let np = CloudError::NoProvider;
        assert_eq!(np.http_status(), None);
    }

    #[test]
    fn parse_proxy_frame_decodes_delta_and_done() {
        let frame = b"data: {\"delta\":\"hello\",\"done\":false}";
        let chunk = parse_proxy_frame(frame).unwrap().unwrap();
        assert_eq!(chunk.delta, "hello");
        assert!(chunk.finish_reason.is_none());

        let frame = b"data: {\"delta\":\"\",\"done\":true,\"usage\":{\"input_tokens\":3,\"output_tokens\":1,\"cached_input_tokens\":0}}";
        let chunk = parse_proxy_frame(frame).unwrap().unwrap();
        assert_eq!(chunk.delta, "");
        assert_eq!(chunk.finish_reason.as_deref(), Some("stop"));
        assert_eq!(chunk.usage.unwrap().input_tokens, 3);
    }

    #[test]
    fn parse_proxy_frame_handles_done_terminator_and_comments() {
        assert!(parse_proxy_frame(b"data: [DONE]").unwrap().is_none());
        assert!(parse_proxy_frame(b": ping").unwrap().is_none());
        assert!(parse_proxy_frame(b"").unwrap().is_none());
    }

    // ── S6.5: tools through proxy ──────────────────────────────────────────

    #[test]
    fn build_proxy_request_forwards_tool_catalog_with_input_schema_rename() {
        // CloudCallInput carries `AITool { parameters: Value }`; the
        // wire shape sent to /api/ai/dispatch must rename
        // `parameters` → `input_schema` to match the TS
        // ToolDefinition contract.
        let params = serde_json::json!({
            "type": "object",
            "properties": { "url": { "type": "string" } },
            "required": ["url"],
        });
        let tools = vec![AITool {
            name: "desktop.open_url".to_string(),
            description: "Open a URL in the user's default browser.".to_string(),
            parameters: params.clone(),
        }];
        let input = CloudCallInput {
            tools: &tools,
            ..input("sk-tk")
        };
        let req = build_proxy_request(&input, "stream");
        let json = serde_json::to_value(&req).expect("serialize");
        let wire_tools = json.get("tools").and_then(|v| v.as_array()).expect("tools");
        assert_eq!(wire_tools.len(), 1);
        let t0 = &wire_tools[0];
        assert_eq!(t0["name"], "desktop.open_url");
        assert_eq!(t0["description"], "Open a URL in the user's default browser.");
        // The critical wire-boundary rename:
        assert_eq!(t0["input_schema"], params);
        // And `parameters` must NOT appear under the wire name.
        assert!(t0.get("parameters").is_none(), "wire must not carry `parameters` field");
    }

    #[test]
    fn build_proxy_request_omits_empty_tools_field() {
        // Some OpenAI-compatible providers (notably Groq) reject an
        // empty `tools: []` array with a 400. The wire skip ensures
        // we only forward `tools` when there is at least one.
        let i = input("sk-tk");
        let req = build_proxy_request(&i, "stream");
        let json = serde_json::to_value(&req).expect("serialize");
        assert!(json.get("tools").is_none(), "tools must be skipped when empty");
    }

    #[test]
    fn parse_proxy_frame_decodes_tool_call_delta() {
        // First delta of a function-call sequence: provider supplies
        // id + name, no argument content yet.
        let frame = b"data: {\"delta\":\"\",\"done\":false,\"tool_call\":{\"index\":0,\"id\":\"call_abc\",\"name\":\"cloud.list_projects\",\"arguments_delta\":\"\"}}";
        let chunk = parse_proxy_frame(frame).unwrap().unwrap();
        let tc = chunk.tool_call.expect("tool_call surfaced");
        assert_eq!(tc.index, 0);
        assert_eq!(tc.id.as_deref(), Some("call_abc"));
        assert_eq!(tc.name.as_deref(), Some("cloud.list_projects"));
        assert_eq!(tc.arguments_delta, "");
        assert!(chunk.finish_reason.is_none(), "non-terminal frame");
    }

    #[test]
    fn parse_proxy_frame_decodes_tool_call_argument_continuation() {
        // Subsequent chunks within the same tool call carry only the
        // index + a slice of arguments. `id` and `name` are None.
        let frame = b"data: {\"delta\":\"\",\"done\":false,\"tool_call\":{\"index\":0,\"arguments_delta\":\"{\\\"limit\\\":\"}}";
        let chunk = parse_proxy_frame(frame).unwrap().unwrap();
        let tc = chunk.tool_call.expect("tool_call surfaced");
        assert_eq!(tc.index, 0);
        assert!(tc.id.is_none());
        assert!(tc.name.is_none());
        assert_eq!(tc.arguments_delta, "{\"limit\":");
    }

    #[test]
    fn parse_proxy_frame_honors_finish_reason_tool_calls() {
        // Terminal chunk for a tool-call closure. The Rust accumulator
        // (`stream_to_bus`) keys on this `finish_reason` to flush the
        // assembled call into the bus.
        let frame = b"data: {\"delta\":\"\",\"done\":true,\"finish_reason\":\"tool_calls\",\"usage\":{\"input_tokens\":12,\"output_tokens\":3,\"cached_input_tokens\":0}}";
        let chunk = parse_proxy_frame(frame).unwrap().unwrap();
        assert_eq!(chunk.finish_reason.as_deref(), Some("tool_calls"));
        let usage = chunk.usage.expect("usage block");
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 3);
    }

    #[test]
    fn parse_proxy_frame_defaults_finish_reason_to_stop() {
        // Legacy server response (no `finish_reason` on terminal) must
        // keep working — defaults to "stop" so existing consumers
        // don't regress.
        let frame = b"data: {\"delta\":\"\",\"done\":true,\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"cached_input_tokens\":0}}";
        let chunk = parse_proxy_frame(frame).unwrap().unwrap();
        assert_eq!(chunk.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parse_proxy_frame_drops_malformed_tool_call_payload() {
        // A `tool_call` field that doesn't satisfy ToolCallDelta's shape
        // (missing required `index`) must NOT panic — drop it silently
        // so the rest of the chunk (a text delta on the same frame, in
        // theory) still flows. The frame parse itself must still
        // succeed.
        let frame = b"data: {\"delta\":\"text\",\"done\":false,\"tool_call\":{\"hello\":\"world\"}}";
        let chunk = parse_proxy_frame(frame).unwrap().unwrap();
        assert_eq!(chunk.delta, "text", "text delta still surfaces");
        assert!(chunk.tool_call.is_none(), "malformed tool_call dropped");
    }
}
