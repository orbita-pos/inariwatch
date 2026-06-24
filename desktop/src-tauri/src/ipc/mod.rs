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

// v0.3 S11 — chat-agent audit log + per-tool permission settings UI.
// Read-only over the existing `tool_invocations` table + the static
// `agent::tools::catalog_all()`. Two of the six commands mutate the
// `PermissionResolver` (set / clear override) — this is the only
// state managed in this module that lives across commands. The
// `ToolRegistry` is intentionally NOT instantiated here; that's S6's
// boot wire-up.
pub mod audit_ui;
// v0.3 S6 — chat-agent tool invocation IPC. `_invoke` returns a
// tagged `InvokeOutcome` so the chat surface can render the three
// terminal states (output / requires_confirm / denied) without
// parsing strings. `_confirm` re-runs after the inline UI prompt;
// `_catalog` enumerates tools for the LLM + the settings UI.
pub mod tool_invoke;
pub mod auth;
// Layer 1 ONNX semantic intent classifier IPC command.
pub mod classify;
pub mod cloud;
pub mod commands;
pub mod connect;
// Session 1 — device-management IPC (list / rename / revoke /
// sign-out-all). Pairs with the new web `/api/desktop/devices/*`
// routes; HTTP impl lives in `crate::cloud::devices`.
pub mod devices;
pub mod eap;
pub mod error;
pub mod events;
pub mod gates;
pub mod git;
// Local LLM IPC — `local_ai_load`, `local_ai_infer`, `local_ai_status`.
// Always compiled — real impl when `local-ai` feature is on, stubs otherwise.
pub mod local_ai;
pub mod mcp;
pub mod memory;
pub mod onboarding;
pub mod remediation;
pub mod replay;
pub mod saves;
pub mod sensors;
pub mod settings;
// Inari Live pure-slash Phase 2 — natural-language → slash command
// suggestion IPC. Single AI surface in the chat input dropdown;
// always returns `Ok(vec![])` on any failure path so the UI degrades
// to "type a slash command explicitly".
pub mod slash;
// v0.3 S5 — `voice_synthesize` / `voice_list_voices` / `voice_status`.
// Piper TTS with synthetic-WAV fallback when the binary isn't installed.
pub mod voice;
// v0.3 S5 — Baileys WhatsApp sidecar control surface
// (`whatsapp_login_start`, `whatsapp_send`, `whatsapp_logout`,
// `whatsapp_list_accounts`, `whatsapp_status`). Manages a Node sidecar
// per `desktop/src-tauri/sidecars/whatsapp/` over JSON-RPC stdio.
pub mod whatsapp;
// v0.3 S8 — pairing primitive IPC surface
// (`desktop_pairing_generate`, `..._list`, `..._revoke`,
// `..._confirm`, `..._cleanup`). The redeem path is exclusively driven
// by the messenger gateway (not exposed here on purpose).
pub mod pairing;
// S12 — mobile-pairing IPC bridge (announce + confirm; the relay-side
// inbound is in `crate::messenger::mobile`).
pub mod mobile_pairing;
pub mod window;
// Inari Live V1 — Session 3 Add-Project wizard IPC. Implementation in
// `crate::wizard::{detect, install, dev}`; this module is the Tauri-
// command shell only.
pub mod wizard;
// Inari Live V1 — Session 5 conversations IPC. CRUD over
// `/api/conversations` via `crate::cloud::conversations`, plus a per-
// conversation SSE subscription manager. The workspace-level SSE
// consumer is auto-spawned in `lib.rs::setup`.
pub mod conversations;
// Inari Live V1 — Settings → Projects panel IPC. Single command
// (`cloud_projects_list`) backed by `crate::cloud::projects`.
pub mod projects;
// Fix Locally — per-project local clone path storage.
// Two commands: `project_set_local_path` / `project_get_local_path`.
pub mod project_local;
// Jarvis-layer user memory — personal fact store for cross-session AI context.
// Commands: list / upsert / delete / wipe / rendered / extract / stats.
pub mod user_memory;
// Inari Live Phase 5.2 — recent-paths buffer IPC. Two commands
// (`desktop_recent_paths_list`, `desktop_recent_paths_add`); storage
// lives in `crate::store::recent_paths`.
pub mod recent_paths;
// Inari Live Phase 5.5 completion — recent-contacts buffer IPC. Two
// commands (`desktop_recent_contacts_list`,
// `desktop_recent_contacts_touch`); storage lives in
// `crate::store::recent_contacts`.
pub mod recent_contacts;

pub use error::IpcError;
