//! OpenAI Chat Completions client — v0.3 S7 shim.
//!
//! Originally (Sesión 18) this file owned the full Chat Completions HTTP
//! stack: bearer auth, retry, SSE parsing, key redaction, the OpenAI
//! base URL, etc. v0.3 S7 moved every byte of that plumbing into
//! [`ai_router_rs`] so there is exactly **one** Rust router for cloud
//! LLM calls. This file is now a thin shim that:
//!
//! - Resolves the API key from settings (BYOK) or `PLATFORM_AI_KEY`.
//! - Translates desktop's [`super::prompts::ChatMessage`] +
//!   [`super::budget::Model`] into the router's
//!   [`ai_router_rs::AIMessage`] + model name.
//! - Calls [`ai_router_rs::dispatch`] / [`ai_router_rs::dispatch_stream`].
//! - Converts the router's response back into the [`ChatResponse`] /
//!   [`ChatChunk`] / [`UsageReport`] shapes the rest of `desktop/`
//!   already consumes.
//!
//! Provider URL strings live ONLY inside the router crate —
//! `crates/ai-router-rs/tests/lockdown.rs` enforces it.
//!
//! `embeddings(...)` keeps its existing local-fastembed delegation; it
//! never touched OpenAI in tree (Sesión 13 made that explicit).

use std::pin::Pin;
use std::sync::Arc;

use ai_router_rs::{
    dispatch, dispatch_stream, AIMessage as RouterMessage, AIProvider, AITool,
    ChatChunk as RouterChatChunk, CloudMode, DispatchInput, Role as RouterRole, TaskName,
    ToolCallDelta,
};
use futures_util::stream::{Stream, StreamExt};
use thiserror::Error;

use crate::cloud::api::read_dashboard_creds_arc;
use crate::store::{settings, Store};

use super::budget::Model;
use super::prompts::{ChatMessage, Role};

/// Env var the platform key lives under. Synced from the web onto disk
/// (Sesión 4 device-flow auth).
pub const PLATFORM_KEY_ENV: &str = "PLATFORM_AI_KEY";

#[derive(Debug, Error)]
pub enum OpenAIError {
    // Hit when none of the three resolution paths produced a usable
    // credential: (1) BYOK in Settings → AI, (2) `PLATFORM_AI_KEY` env
    // (server-side only — not on the user's desktop), (3) proxy mode
    // via a paired cloud session.
    //
    // The message used to read "no API key configured" — accurate for
    // 2026-04 when the client was wired directly to OpenAI, but
    // misleading after the Qwen-via-Together migration (the cloud's
    // `/api/ai/dispatch` is where all provider routing lives now).
    // For most desktop users, the actionable fix is *pair with the
    // cloud* — that unlocks proxy mode and the server picks the right
    // provider per-task. BYOK stays as the offline-friendly fallback.
    #[error("Not paired with cloud. Sign in to Inari (Settings → Account) so chat can route through the platform, or set a BYOK key in Settings → AI.")]
    NoKey,
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("OpenAI returned {status}: {body}")]
    Api { status: u16, body: String },
    #[error("invalid JSON in stream chunk: {0}")]
    BadChunk(String),
    /// Retained for source compatibility — Sesión 13 wired
    /// [`OpenAIClient::embeddings`] to local fastembed so nothing in
    /// tree raises this anymore. Kept (instead of removed) so
    /// downstream callers compiled against earlier shapes do not see
    /// an exhaustive-match break.
    #[error("not implemented in this build")]
    NotImplemented,
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
    #[error("router dispatch: {0}")]
    Router(String),
}

impl From<ai_router_rs::DispatchError> for OpenAIError {
    fn from(e: ai_router_rs::DispatchError) -> Self {
        // Map provider HTTP errors back into [`OpenAIError::Api`] so
        // callers that pattern-match on `status` keep working.
        if let ai_router_rs::DispatchError::Cloud(ref ce) = e {
            if let Some(status) = ce.http_status() {
                return OpenAIError::Api {
                    status,
                    body: ce.to_string(),
                };
            }
        }
        OpenAIError::Router(e.to_string())
    }
}

/// One streamed chunk from the chat completion. Field set is unchanged
/// from Sesión 18 so the dock's `installChatStreamDriver` consumer
/// keeps compiling.
///
/// S6 added the optional `tool_call` mirror so the streaming wrapper
/// (`stream_to_bus`) can detect and accumulate function-calling deltas
/// without inspecting the router-level `ChatChunk` directly. The field
/// is `None` on every chunk in non-tool conversations (the existing
/// dispatch path), so existing consumers keep working.
#[derive(Debug, Clone)]
pub struct ChatChunk {
    /// Delta token. Empty on the very first chunk and the closing one.
    pub delta:         String,
    /// `"stop"` / `"length"` / `"content_filter"` / `"tool_calls"`.
    /// `Some(_)` on the chunk that closes the stream.
    pub finish_reason: Option<String>,
    /// Optional usage block carried by the final chunk.
    pub usage:         Option<UsageReport>,
    /// S6 — partial tool call payload (function-calling). Populated
    /// by the OpenAI adapter when the request body carried a `tools:`
    /// array. Other providers leave this `None`.
    pub tool_call:     Option<ToolCallDelta>,
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
    api_key: String,
    /// Optional override that points the underlying ai-router-rs
    /// direct-mode adapter at a different host. Used by integration
    /// tests to wire mock servers (`OpenAIClient::with_key("sk-test")
    /// .with_base_url(format!("http://{addr}"))`). `None` in production —
    /// the adapter then resolves the pinned provider URL.
    base_url: Option<String>,
    /// When `Some`, overrides the router's env-based mode selection.
    /// Set to `CloudMode::Proxy { url, token }` when the desktop is
    /// paired but has no local API key — the web endpoint then uses
    /// its platform key server-side.
    cloud_mode: Option<CloudMode>,
}

impl OpenAIClient {
    /// Build a client by resolving the active key from the settings
    /// store. Resolution order:
    ///   1. BYOK (`openai_byok_key` setting)
    ///   2. `PLATFORM_AI_KEY` env var
    ///   3. Proxy mode — if the desktop is paired (`DashboardCreds`
    ///      has a token), routes through the web's `/api/ai/dispatch`
    ///      which uses the server-side platform key. No local key needed.
    ///
    /// Returns [`OpenAIError::NoKey`] only if none of the three paths
    /// is available (no BYOK, no env key, not paired).
    pub fn from_store(store: &Arc<Store>) -> Result<Self, OpenAIError> {
        match resolve_key(store) {
            Ok(key) => Ok(Self::with_key(key)),
            Err(OpenAIError::NoKey) => {
                // Fallback: proxy mode via the paired web endpoint.
                let creds = read_dashboard_creds_arc(store);
                if let Some(token) = creds.token {
                    let url = creds.base_url.trim_end_matches('/').to_string();
                    Ok(Self {
                        api_key:    String::new(),
                        base_url:   None,
                        cloud_mode: Some(CloudMode::Proxy { url, token }),
                    })
                } else {
                    Err(OpenAIError::NoKey)
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Build a client from a literal key. Used in tests + by callers
    /// that already resolved the key (e.g. budget gate).
    pub fn with_key(key: impl Into<String>) -> Self {
        Self {
            api_key:    key.into(),
            base_url:   None,
            cloud_mode: None,
        }
    }

    /// Override the upstream HTTP host for the next dispatch. Used by
    /// integration tests to point chat_complete/chat_stream at a
    /// mockito server. The override is plumbed through ai-router-rs's
    /// `DispatchInput::base_url_override`; the lockdown stays intact
    /// because no provider URL leaks outside the router crate.
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    /// Streaming chat. Returns a stream of [`ChatChunk`]s; the terminal
    /// chunk carries `finish_reason: Some(_)` (and, when the upstream
    /// provider exposes it, `usage`). Backwards-compat wrapper around
    /// [`Self::chat_stream_with_tools`] with an empty tool catalog —
    /// preserves Sesión-18 callers (`single_shot.rs`, integration
    /// tests) that don't drive function calling.
    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        model:    Model,
    ) -> Result<
        Pin<Box<dyn Stream<Item = Result<ChatChunk, OpenAIError>> + Send>>,
        OpenAIError,
    > {
        self.chat_stream_with_tools(messages, model, &[]).await
    }

    /// S6 — streaming chat with an optional function-calling catalog.
    /// Originally consumed by the dock's `ipc::chat::start_chat_stream`
    /// IPC (deleted in Phase 4.6 of the pure-slash refactor) which
    /// passed the live `Arc<ToolRegistry>` tool list through here. The
    /// method itself is preserved for future structured-streaming
    /// callers — each emitted chunk may carry `tool_call:
    /// Some(ToolCallDelta)` when the LLM emits a function call;
    /// `streaming.rs::stream_to_bus` is responsible for accumulating
    /// across deltas and dispatching the assembled call.
    pub async fn chat_stream_with_tools(
        &self,
        messages: &[ChatMessage],
        model:    Model,
        tools:    &[AITool],
    ) -> Result<
        Pin<Box<dyn Stream<Item = Result<ChatChunk, OpenAIError>> + Send>>,
        OpenAIError,
    > {
        let mapped = map_messages(messages);
        let model_name = model.api_name().to_string();
        let mut input = DispatchInput::new(
            TaskName::ChatCode,
            self.api_key.as_str(),
            "",
            &mapped,
            // ai-router-rs requires u32; mirror Sesión 18's
            // open-ended-stream behavior by passing a generous cap.
            4096,
        );
        input.model = Some(model_name.as_str());
        // NO hardcoded provider — let the server-side routing decide.
        // Previously this set `provider = Openai` unconditionally, which
        // sabotaged the platform-funded Together routing override at
        // `/api/ai/dispatch`: the override gave the right key + model but
        // this hardcode forced the dispatch to the OpenAI adapter, which
        // then 401'd on a `tgp_v1_*` Bearer token. The server already
        // routes via task name (rules.ts) + getTogetherOverride(), and
        // BYOK callers carry their provider in their key prefix anyway.
        input.base_url_override = self.base_url.as_deref();
        input.cloud_mode_override = self.cloud_mode.clone();
        input.tools = tools;

        let inner = dispatch_stream(input).await?;
        let mapped_stream = inner.map(|res| match res {
            Ok(c) => Ok(map_chunk(c)),
            Err(e) => Err(OpenAIError::from(e)),
        });
        Ok(Box::pin(mapped_stream))
    }

    /// One-shot non-streaming chat.
    pub async fn chat_complete(
        &self,
        messages: &[ChatMessage],
        model:    Model,
    ) -> Result<ChatResponse, OpenAIError> {
        let mapped = map_messages(messages);
        let model_name = model.api_name().to_string();
        let mut input = DispatchInput::new(
            TaskName::ChatCode,
            self.api_key.as_str(),
            "",
            &mapped,
            4096,
        );
        input.model = Some(model_name.as_str());
        // NO hardcoded provider — see chat_stream_with_tools above.
        input.base_url_override = self.base_url.as_deref();
        input.cloud_mode_override = self.cloud_mode.clone();

        let resp = dispatch(input).await?;
        Ok(ChatResponse {
            content: resp.text,
            usage: UsageReport {
                prompt_tokens: resp.usage.input_tokens.max(0) as u32,
                completion_tokens: resp.usage.output_tokens.max(0) as u32,
            },
            model: resp.model,
        })
    }

    /// Embed `texts` into 384-dim vectors via the bundled fastembed
    /// MiniLM-L6-v2 model. Sesión 13 deliberately resolves embeddings
    /// locally — the model is already loaded for the indexer's code
    /// search and the dimension matches the existing
    /// `code_embeddings FLOAT[384]` schema. See
    /// `INARI_LIVE_DECISIONS.md` 2026-05-01 for the rationale.
    ///
    /// Returns an empty vector for empty input. Bubbles fastembed
    /// model-load failures through [`OpenAIError::Api`] so the caller
    /// can surface "no embeddings — running offline?" without a new
    /// error variant.
    pub async fn embeddings(
        &self,
        texts: Vec<String>,
    ) -> Result<Vec<Vec<f32>>, OpenAIError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let join = tokio::task::spawn_blocking(move || {
            crate::indexer::embeddings::embed_batch(&texts)
        })
        .await
        .map_err(|e| OpenAIError::Api {
            status: 0,
            body:   format!("embed spawn_blocking join: {e}"),
        })?;
        let arrays = join.map_err(|e| OpenAIError::Api {
            status: 0,
            body:   format!("local embed failed: {e}"),
        })?;
        Ok(arrays.into_iter().map(|a| a.to_vec()).collect())
    }
}

fn map_messages(messages: &[ChatMessage]) -> Vec<RouterMessage> {
    messages
        .iter()
        .map(|m| RouterMessage {
            role: match m.role {
                Role::System => RouterRole::System,
                Role::User => RouterRole::User,
                Role::Assistant => RouterRole::Assistant,
            },
            content: m.content.clone(),
        })
        .collect()
}

fn map_chunk(c: RouterChatChunk) -> ChatChunk {
    ChatChunk {
        delta: c.delta,
        finish_reason: c.finish_reason,
        usage: c.usage.map(|u| UsageReport {
            prompt_tokens: u.input_tokens.max(0) as u32,
            completion_tokens: u.output_tokens.max(0) as u32,
        }),
        tool_call: c.tool_call,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_messages_preserves_role_and_content() {
        let m = vec![
            ChatMessage::system("be terse"),
            ChatMessage::user("hi"),
            ChatMessage::assistant("hello"),
        ];
        let r = map_messages(&m);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].role, RouterRole::System);
        assert_eq!(r[0].content, "be terse");
        assert_eq!(r[1].role, RouterRole::User);
        assert_eq!(r[1].content, "hi");
        assert_eq!(r[2].role, RouterRole::Assistant);
        assert_eq!(r[2].content, "hello");
    }

    #[test]
    fn map_chunk_translates_usage() {
        let c = RouterChatChunk {
            delta: "hi".to_string(),
            finish_reason: Some("stop".to_string()),
            usage: Some(ai_router_rs::AIUsage {
                input_tokens: 10,
                output_tokens: 4,
                cached_input_tokens: 0,
            }),
            tool_call: None,
        };
        let m = map_chunk(c);
        assert_eq!(m.delta, "hi");
        assert_eq!(m.finish_reason.as_deref(), Some("stop"));
        let u = m.usage.unwrap();
        assert_eq!(u.prompt_tokens, 10);
        assert_eq!(u.completion_tokens, 4);
        assert!(m.tool_call.is_none());
    }

    #[test]
    fn map_chunk_forwards_tool_call_delta() {
        let c = RouterChatChunk {
            delta: String::new(),
            finish_reason: None,
            usage: None,
            tool_call: Some(ToolCallDelta {
                index: 0,
                id: Some("call_123".to_string()),
                name: Some("desktop.open_url".to_string()),
                arguments_delta: "{\"url\":\"https".to_string(),
            }),
        };
        let m = map_chunk(c);
        let tc = m.tool_call.expect("tool_call mapped");
        assert_eq!(tc.index, 0);
        assert_eq!(tc.name.as_deref(), Some("desktop.open_url"));
        assert_eq!(tc.id.as_deref(), Some("call_123"));
    }

    #[test]
    fn from_dispatch_error_maps_api_status() {
        // Synthetic: the conversion path matters more than fidelity
        // to a real upstream — production tests live in
        // ai-router-rs/src/providers.
        use ai_router_rs::DispatchError;
        let e = DispatchError::Cloud(ai_router_rs::adapters::cloud_proxy::CloudError::ProxyApi {
            status: 429,
            body: "rate limited".to_string(),
        });
        let mapped: OpenAIError = e.into();
        match mapped {
            OpenAIError::Api { status, .. } => assert_eq!(status, 429),
            other => panic!("expected Api, got {other:?}"),
        }
    }

    #[test]
    fn with_key_stores_api_key() {
        let c = OpenAIClient::with_key("sk-test");
        assert_eq!(c.api_key, "sk-test");
    }
}
