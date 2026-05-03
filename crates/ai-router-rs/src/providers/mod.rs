//! Internal provider adapters. NOT exported as `pub use` from
//! [`crate`] — surface code calls [`crate::dispatch`] which selects an
//! adapter based on the resolved [`crate::rules::Target`].
//!
//! Two real adapters today:
//! - [`openai_compat`] — OpenAI, Grok, Gemini, DeepSeek (same body
//!   shape, different base URLs and auth headers).
//! - [`anthropic`] — Claude `/v1/messages` (different shape).
//!
//! Embeddings, tool-use, and vision are intentionally **not** wired in
//! v0.3 S7 — neither `cli/` nor `desktop/src-tauri/` consume those
//! capabilities through the cloud today (the desktop's existing
//! `embeddings(...)` delegates to local fastembed; cli has no
//! embed/tool/vision callsite). When a surface needs one we expose it
//! here and add a [`crate::dispatch::DispatchInput`] mode.

pub mod anthropic;
pub mod openai_compat;
pub mod types;

pub use anthropic::AnthropicAdapter;
pub use openai_compat::OpenAICompatAdapter;
