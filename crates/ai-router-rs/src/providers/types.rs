//! Shared message + usage types across providers. Mirror of
//! `packages/ai-router/src/providers/types.ts` (narrowed to the surface
//! cli/ and desktop/ actually consume in v0.3 S7).
//!
//! S6 of the chat-agent stream extends [`ChatChunk`] with an optional
//! [`ToolCallDelta`] (additive — non-streaming consumers ignore it).
//! The OpenAI adapter is the only one wired to populate it today
//! (function calling); other providers leave `tool_call: None` and the
//! desktop boot wiring scope-cuts tool catalog injection to OpenAI.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rules::AIProvider;

/// One conversation turn handed to a provider. Mirrors the TS `AIMessage`
/// type. Content is a string today — multimodal lives in a future
/// `AIVisionMessage` we have not yet wired in Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AIMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    pub const fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

impl AIMessage {
    pub fn user(content: impl Into<String>) -> AIMessage {
        AIMessage {
            role: Role::User,
            content: content.into(),
        }
    }
    pub fn assistant(content: impl Into<String>) -> AIMessage {
        AIMessage {
            role: Role::Assistant,
            content: content.into(),
        }
    }
    pub fn system(content: impl Into<String>) -> AIMessage {
        AIMessage {
            role: Role::System,
            content: content.into(),
        }
    }
}

/// Token counters. Mirrors `AIUsage` in the TS providers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AIUsage {
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub cached_input_tokens: i64,
}

/// Mirrors `AIResponse` in the TS providers.
#[derive(Debug, Clone)]
pub struct AIResponse {
    pub text: String,
    pub usage: AIUsage,
    pub model: String,
    pub provider: AIProvider,
}

/// One streamed chunk from a provider's chat completion stream.
/// Mirrors `desktop/src-tauri/src/ai/openai.rs::ChatChunk` so the desktop
/// migration is a textual rename, not a shape change.
#[derive(Debug, Clone, Default)]
pub struct ChatChunk {
    /// Delta token. Empty on the first chunk (which only carries the
    /// role) and on the terminal chunk (which only carries
    /// finish_reason / usage).
    pub delta: String,
    /// `"stop"` / `"length"` / `"content_filter"` / `"tool_calls"` —
    /// `Some(_)` on the chunk that closes the stream.
    pub finish_reason: Option<String>,
    /// Optional usage block carried by the final chunk when the
    /// provider supports it (OpenAI's `stream_options.include_usage`).
    pub usage: Option<AIUsage>,
    /// S6 — partial tool call payload. Populated by providers that
    /// expose function calling natively (OpenAI today). Each delta
    /// carries either a tool name (first chunk per call) or a slice
    /// of the JSON arguments string. Consumers (`stream_to_bus` in
    /// desktop) accumulate per `index` until `finish_reason ==
    /// Some("tool_calls")` arrives, then dispatch the assembled call
    /// through the local `ToolRegistry`.
    pub tool_call: Option<ToolCallDelta>,
}

/// One ChatGPT-style tool/function declaration the LLM may emit a call
/// for. Mirrors the OpenAI request shape (`tools[].function.{name,
/// description, parameters}`); other providers translate at the
/// adapter boundary.
///
/// `parameters` is a JSON Schema object. Desktop builds it from each
/// `agent::ToolMeta::params_schema` so the wire form on this side is
/// the same `Value` the registry already validates against.
#[derive(Debug, Clone, Serialize)]
pub struct AITool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Streaming-time fragment of an LLM-emitted tool call. The OpenAI
/// adapter populates one per SSE chunk that has `delta.tool_calls`;
/// `stream_to_bus` accumulates by `index` until the closing
/// `finish_reason: tool_calls` chunk arrives.
///
/// Wire fields:
/// - `index` — OpenAI's `tool_calls[i].index`. Stable across deltas
///   for the SAME tool call. Multiple parallel tool calls in one
///   assistant message increment this.
/// - `id` — `tool_calls[i].id`. Provider-issued; the desktop bus
///   echoes it as the chat-frontend's `tool_call.id`.
/// - `name` — set on the FIRST delta that carries
///   `function.name`; subsequent deltas leave it `None`.
/// - `arguments_delta` — partial JSON arguments string. Concatenate
///   per `index` to assemble the full payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallDelta {
    pub index: u32,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments_delta: String,
}
