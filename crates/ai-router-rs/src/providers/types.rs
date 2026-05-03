//! Shared message + usage types across providers. Mirror of
//! `packages/ai-router/src/providers/types.ts` (narrowed to the surface
//! cli/ and desktop/ actually consume in v0.3 S7).

use serde::{Deserialize, Serialize};

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
}
