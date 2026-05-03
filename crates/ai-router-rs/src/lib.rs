//! `ai-router-rs` — Rust mirror of `@inariwatch/ai-router`.
//!
//! Per `INARI_AI_ARCHITECTURE.md` (LOCKED 2026-05-02), this crate is the
//! single entry point for every AI call originating from `cli/` and
//! `desktop/src-tauri/`. The lockdown integration test (`tests/lockdown.rs`)
//! enforces that no other Rust code in the monorepo issues HTTP requests
//! to provider endpoints (api.openai.com, api.anthropic.com, etc.) —
//! every byte that leaves the binary on its way to a cloud LLM goes
//! through `dispatch()` here.
//!
//! ## Public surface
//!
//! ```ignore
//! use ai_router_rs::{dispatch, DispatchInput, TaskName};
//!
//! let out = dispatch(DispatchInput::Complete {
//!     task: TaskName::AlertAutoAnalyze,
//!     api_key: api_key,
//!     system_prompt: "...".into(),
//!     messages: vec![ /* ... */ ],
//!     ..Default::default()
//! }).await?;
//! ```
//!
//! ## What lives here
//!
//! | Module | Purpose |
//! |---|---|
//! | [`tasks`] | `TaskName` enum mirroring the 30 TS tasks |
//! | [`rules`] | `Rule` / `Target` / `WorkspacePreferences` + `resolve_primary` |
//! | [`receipts`] | `RouterReceipt` + `ReceiptSink` trait + sinks registry |
//! | [`dispatch`] | `dispatch()` and streaming entry points |
//! | [`providers`] | Internal HTTP adapters (OpenAI-compat, Anthropic) |
//! | [`adapters`] | Substrate adapters (cloud_proxy dual-mode, llamacpp trait) |
//!
//! ## What does NOT live here
//!
//! - `tauri::*` — the desktop app's IPC layer wires its own llamacpp
//!   adapter against the [`adapters::llamacpp::LocalSidecar`] trait. We
//!   never depend on `tauri-*`.
//! - Ed25519 signing — TS receipts are metadata-only as of Phase 1
//!   (see `packages/ai-router/src/receipts.ts`). When TS adds signing in
//!   Phase 4+ we mirror it here; until then the `signature` field on
//!   [`receipts::RouterReceipt`] stays `None`.

pub mod adapters;
pub mod dispatch;
pub mod providers;
pub mod receipts;
pub mod rules;
pub mod tasks;

pub use adapters::cloud_proxy::CloudMode;
pub use adapters::llamacpp::{
    install_local_sidecar, local_sidecar_installed, uninstall_local_sidecar, LocalSidecar,
    LocalSidecarError,
};
pub use dispatch::{
    dispatch, dispatch_stream, CallOpts, DispatchError, DispatchInput, DispatchOutput,
    DispatchStreamChunk, EmbedInput, ToolUseInput, VisionInput, WorkspaceContext,
};
pub use providers::types::{AIMessage, AIResponse, AIUsage, ChatChunk, Role};
pub use receipts::{
    clear_receipt_sinks, emit_receipt, receipt_sink_count, register_receipt_sink, ReceiptSink,
    RelayPath, RouterReceipt,
};
pub use rules::{
    detect_provider, get_rule, resolve_primary, rules, AIProvider, FallbackTrigger, Rule,
    Substrate, Target, WorkspaceFlag, WorkspacePreferences,
};
pub use tasks::{namespace_of, TaskName, TaskNamespace, ALL_TASKS};
