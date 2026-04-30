//! Tauri command surface — the only public crossing between the
//! webview and the Rust core.
//!
//! - [`error`]      — typed [`IpcError`] with discrete variants for the
//!                    most-actionable [`crate::store::StoreError`] cases.
//! - [`commands`]   — the 5 Session-4 commands (`daemon_status`,
//!                    `list_repos`, `open_repo`, `close_repo`,
//!                    `get_logs`).
//! - [`events`]     — bus-event → Tauri-event bridge (`daemon:event` +
//!                    `daemon:status_changed` debounced).
//! - [`auth`]       — device-flow Tauri-command shells (RENAMED from
//!                    `desktop_auth.rs`).
//! - [`onboarding`] — folder-pick + first-run-status (RENAMED from
//!                    `onboarding.rs`).
//! - [`settings`]   — settings get/set/logout (RENAMED from
//!                    `settings.rs`'s command surface).
//! - [`connect`]    — connect-project shells (RENAMED from
//!                    `connect.rs`'s Tauri commands; impl in
//!                    [`crate::cli::run`]).
//!
//! Heavy-data IPC rule (locked Session 1 — see ARCHITECTURE.md):
//! NEVER serialize embeddings, full ASTs, lists with > 10 000 entries,
//! or diffs > 100 KB through Tauri IPC. Heavy data flows over the
//! local MCP HTTP transport (Session 7).

pub mod auth;
pub mod commands;
pub mod connect;
pub mod error;
pub mod events;
pub mod mcp;
pub mod onboarding;
pub mod saves;
pub mod settings;

pub use error::IpcError;
