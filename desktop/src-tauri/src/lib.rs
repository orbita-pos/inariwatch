use std::sync::Arc;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;

// Pre-Session-2 modules still owned by their named sessions:
// - `fingerprint` HAS MOVED to `memory/fingerprint.rs` (Session 11). Kept
//   exposed at `crate::fingerprint` via the re-export below so legacy
//   call-sites in `inari_watcher.rs` keep resolving until Session 10 splits
//   that file. Once the split lands, drop the re-export and move callers.
// - `inari_watcher` is split across Sessions 5/10/12; deleted end of S10.
// - `local_ingest` HAS MOVED to `sensors/substrate/local_ingest.rs`
//   (Session 10). Its previous `start()` boot-up call from this file is
//   removed; the new home owns its own spawn site.
//
// `pub(crate)` so the S7 `tray` module can read/toggle `is_paused`
// when the user clicks the "Pause watch" tray item.
pub(crate) mod inari_watcher;

// Session 2 — daemon core + window helpers.
pub mod daemon;
// `pub` so the Session 14 integration tests in `tests/window_*` can
// reach `crate::window::dock::*` / `window::main::*` /
// `window::shortcuts::{resolve, ShortcutAction}`. Same precedent as
// `daemon` (S2), `store` (S3), `sensors` (S5/S7), `indexer` (S6).
pub mod window;

// Session 3 — local store. `pub` for the same reason as `daemon`:
// integration tests in `tests/` exercise migrations/PRAGMAs/sqlite-vec.
pub mod store;

// Session 4 — cloud / IPC / AI cloud-proxy shells / cli runner.
pub mod cloud;
pub mod ipc;
// `pub` so Sesión 18 integration tests in `tests/openai_*`,
// `tests/budget_*`, and `tests/prompts_parity` can reach
// `crate::ai::{openai, budget, prompts}`. Same precedent as `daemon`,
// `store`, `sensors`, `indexer`, `cli`.
pub mod ai;
// `pub` so integration tests in `tests/substrate_*` can reach
// `crate::cli::run::{prepare_inari_run, ...}` for Sesión 10. Same
// precedent as `daemon` (S2), `store` (S3), `sensors` (S5/S7/S10).
pub mod cli;

// Sesión 20 — local-subset gate runner (Gates 5, 6, 9). `pub` so the
// integration tests in `tests/gate_runner_*` and `tests/pre_push_*`
// can reach `crate::gates::{run_local_subset, GateRunInput, ...}`.
pub mod gates;
// `pub` so integration tests in `tests/indexer_*` can reach
// `crate::indexer::{parser, semantic, Lang, ...}`. Same precedent as
// `daemon` (S2), `store` (S3), `sensors` (S5/S7).
pub mod indexer;
// `pub` so integration tests in `tests/memory_md_*` (Session 11) can
// reach `crate::memory::declarative::{ensure_memory_md, ...}`. Same
// precedent as `daemon` (S2), `store` (S3), `indexer` (S6),
// `sensors` (S5/S7).
pub mod memory;
// `pub` so integration tests in `tests/fs_*` and `tests/mcp_*` can drive
// the FS sensor actor and mount the MCP axum router. Same precedent as
// `daemon` (Sesión 2) and `store` (Sesión 3).
pub mod sensors;
mod telemetry;
mod updater;

// S7 — ambient surfaces support. Owns the `AmbientAction` dispatcher
// + `LastAlertStore` + the tray-side stacktrace location extractor.
// `pub` so integration tests in `tests/ambient_actions.rs` can drive
// `handle_ambient_action` against a registry seeded with mock
// backends — same precedent as `agent` (S2/S6).
pub mod notifications;

// S7 — system tray (icon + menu + click handlers). Extracted from
// the inline `setup_tray` that lived in `lib.rs::run` pre-S7. `pub`
// so a future tray-structure assertion test can resolve
// `crate::tray::menu::build_menu` without going through the live
// boot path.
pub mod tray;

// Sesión 21 — local AI runtime (llama.cpp sidecar + lazy model
// registry). `pub` so the integration tests in `tests/local_ai_*.rs`
// can reach `crate::local_ai::{LocalAI, ModelRegistry, RuntimeManager,
// hardware}`. Same precedent as `daemon` (S2), `store` (S3),
// `sensors` (S5/S7), `ai` (S18). No Tauri commands wired this
// session — S22's LSP completion handler is the first IPC consumer.
pub mod local_ai;

// Re-export of the relocated fingerprint module so the literal path
// `crate::fingerprint::*` keeps resolving for `inari_watcher.rs` (out of
// scope for Session 11's edits). Drop after Session 10 splits the watcher.
pub use memory::fingerprint;

// Sesión 22 (v0.2) — LSP server. `pub` so integration tests in
// `tests/lsp_*` can reach `crate::lsp::{LspState, start_lsp_server_for_test, ...}`.
pub mod lsp;

// Sesión 28 (v0.2) — EAP receipt verifier (shared between the
// `inari-verify` standalone CLI binary and any future in-app
// verification surface). Pure-crypto module — no DB, no network. The
// `inari-verify` bin in `src/bin/inari_verify.rs` reaches this via
// `inariwatch_desktop_lib::lib_eap_verify`.
pub mod lib_eap_verify;

// v0.3 S2 — WS relay client (Inari Live registers with relay.inariwatch.com
// at boot and keeps a long-lived WS open so the InariWatch cloud router
// can dispatch `notify.compose.*` / `voice.tts.*` / `chat.conversational`
// tasks here when the workspace flag is on. v0.3 S3 wires the first real
// per-task handler (`notify.compose.email` → `notify_compose::compose_email`).
// `pub` so integration tests in `tests/relay_client_test.rs` reach
// `RelayConfig` / `Backoff` / `handle_dispatch`.
pub mod relay_client;

// v0.3 S3 — notify.compose.email handler. First "cómo decirlo" task to
// run on the user's local model per `INARI_AI_ARCHITECTURE.md` §1
// (LOCKED 2026-05-02). `pub` so unit tests + the relay_client dispatcher
// can reach the prompt builder, response parser, and signed-receipt
// helpers without going through the streaming model path.
//
// v0.3 S5 — extends with `notify_compose::whatsapp` (transport-agnostic
// body composer; the Baileys sidecar in `crate::whatsapp` actually sends).
pub mod notify_compose;

// v0.3 S5 — voice.tts.* surface. Piper-backed local TTS with synthetic
// WAV fallback when the binary isn't installed yet. `pub` so the
// integration tests + the IPC layer can both reach `synthesize`,
// `models::lookup`, and `handle_voice_tts_dispatch`.
pub mod voice;

// v0.3 S5 — Baileys WhatsApp sidecar manager. Spawns a Node child process
// (sidecars/whatsapp/dist/main.js, bundled at build time) at app start,
// JSON-RPC over stdin/stdout. Per-account QR-paired sessions live under
// `<app_local_data_dir>/whatsapp/<account_id>/`. NO Meta Cloud API,
// NO Twilio — alerts go FROM the user's own WhatsApp account.
//
// `pub` so the relay dispatcher (`relay_client::handle_dispatch_with_voice`)
// + IPC layer can both reach `SidecarManager::send_message`.
pub mod whatsapp;

// v0.3 S2 (chat-agent foundation) — ChatTool trait, tool registry,
// permission pipeline, witness receipt emission, SQLite audit log,
// filesystem skill loader. The shape is opinionated by design (see
// `INARI_LIVE_AGENT_PLAN.md` §S2): one `execute()` per tool, JSON
// args, automatic witness emission. S3-S5 add concrete tools, S6
// wires the registry into the chat surface, S11 reads the audit log
// for the activity-feed UI. `pub` so integration tests in
// `tests/agent_*.rs` can drive the pipeline directly.
pub mod agent;

// v0.3 S8 — pairing primitive (Crockford codes + 6-digit SAS +
// `paired_entities` SQLite table). Backs both the WhatsApp DM gate
// (`crate::messenger`) today and the S12 mobile-pairing PWA tomorrow.
// `pub` so integration tests in `tests/messenger_ipc.rs` /
// `tests/messenger_e2e.rs` can drive the service directly without
// going through the IPC layer.
pub mod pairing;

// v0.3 S8 — messenger-as-UI gateway. WhatsApp inbound gets the full
// AI-loop pipeline locally (witness bit-exact); Telegram + Slack
// surface as read-only mirrors of the existing web bots until S8.5
// flips them into bidirectional. `pub` so integration tests in
// `tests/messenger_*.rs` can drive the gateway directly without going
// through Tauri.
pub mod messenger;

// Inari Live V1 — Session 3 Add-Project wizard. Owns:
//   * `WizardStore` — Mutex-wrapped pending payload queue.
//   * `detect`     — local clone scan + framework / host detection.
//   * `install`    — npm install + config patch + .env.local + mint +
//                    Vercel sync + keyring backup.
//   * `dev`        — spawn `npm run dev` + auto-inject test event.
// `pub` so the integration tests (and the relay dispatcher arm in
// `relay_client::handle_dispatch_full`) can reach the surface.
pub mod wizard;

pub const LSP_DEFAULT_PORT: u16 = 9877;

const INARI_WINDOW_LABEL: &str = "inari";

// ── Entry ─────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        // v0.3 S3 — backs `desktop.open_in_editor` / `desktop.open_url` /
        // `desktop.read_clipboard` / `desktop.write_clipboard` in the
        // chat-agent tool registry. Boot-time wire-up of the registry
        // itself happens in S6.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // .plugin(tauri_plugin_updater::Builder::new().build()) // disabled for dogfood — needs plugins.updater config
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Session 14 — fan out fired shortcuts via window::shortcuts::handle_event.
                .with_handler(|app, shortcut, event| {
                    window::shortcuts::handle_event(app, shortcut, event.state());
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            // Session 4 — IPC core
            ipc::commands::daemon_status,
            ipc::commands::list_repos,
            ipc::commands::desktop_git_origin_url,
            ipc::commands::open_repo,
            ipc::commands::close_repo,
            ipc::commands::get_logs,
            // Auth (renamed from desktop_auth.rs)
            ipc::auth::desktop_auth_start,
            ipc::auth::desktop_auth_poll,
            ipc::auth::desktop_auth_status,
            // Session 1 — device-management IPC.
            ipc::devices::desktop_devices_list,
            ipc::devices::desktop_devices_rename,
            ipc::devices::desktop_devices_revoke,
            ipc::devices::desktop_devices_sign_out_all,
            // Inari Live V1 — Settings → Projects panel.
            ipc::projects::cloud_projects_list,
            // Fix Locally — per-project local clone path.
            ipc::project_local::project_set_local_path,
            ipc::project_local::project_get_local_path,
            // Onboarding (renamed from onboarding.rs)
            ipc::onboarding::desktop_first_run_status,
            ipc::onboarding::desktop_pick_watch_dir,
            ipc::onboarding::desktop_save_watch_dir,
            // Settings (renamed from settings.rs)
            ipc::settings::desktop_get_settings,
            ipc::settings::desktop_save_settings,
            ipc::settings::desktop_logout,
            ipc::settings::desktop_open_settings,
            ipc::settings::desktop_app_version,
            // Saves (renamed from saves.rs)
            ipc::saves::desktop_get_saves_summary,
            // Connect (renamed from connect.rs)
            ipc::connect::desktop_connect_project,
            ipc::connect::desktop_disconnect_project,
            ipc::connect::desktop_connect_status,
            // Cloud-proxied autofix (Sesión 4 — renamed from autofix.rs;
            // module renamed cloud_proxy → proxy in Sesión 19)
            ai::remediate::proxy::desktop_autofix_start,
            // Session 7 — local MCP server controls
            ipc::mcp::get_mcp_token,
            ipc::mcp::regenerate_mcp_token,
            ipc::mcp::install_mcp_for,
            ipc::mcp::uninstall_mcp_for,
            ipc::mcp::list_mcp_clients_status,
            // Session 11 — declarative memory (memory.md lifecycle)
            ipc::memory::read_memory_md,
            ipc::memory::propose_memory_md_update,
            ipc::memory::commit_memory_md,
            ipc::memory::get_context_stack,
            ipc::memory::wipe_memory,
            // Session 8 — git hook installer + status
            ipc::git::install_git_hooks,
            ipc::git::uninstall_git_hooks,
            ipc::git::git_hooks_status,
            ipc::git::get_git_hook_token,
            // Sesión 17 — settings (general / notifications / ai / privacy / about / repos)
            ipc::settings::get_general_settings,
            ipc::settings::set_general_settings,
            ipc::settings::get_notifications_settings,
            ipc::settings::set_notifications_settings,
            ipc::settings::get_ai_settings,
            ipc::settings::set_ai_settings,
            ipc::settings::get_privacy_settings,
            ipc::settings::set_privacy_settings,
            ipc::settings::get_about_info,
            ipc::settings::set_release_channel,
            ipc::settings::check_for_updates,
            ipc::settings::get_repos_list,
            ipc::settings::wipe_repo_memory,
            // Sesión 17 — onboarding flow
            ipc::onboarding::onboarding_open_repo,
            ipc::onboarding::onboarding_progress,
            ipc::onboarding::complete_onboarding,
            ipc::onboarding::is_onboarded,
            // Sesión 17 — window navigation
            ipc::window::open_main_window,
            ipc::window::hide_dock,
            ipc::window::navigate,
            // Sesión 18 — chat streaming
            // (REMOVED in Phase 4.6 of pure-slash refactor, 2026-05-15.
            //  Inari Live's input is a slash-only command bar; the
            //  legacy `start_chat_stream` deprecation stub had no live
            //  callers after Phase 3 stopped the dock from sending
            //  free-text submits. The `local_ai_infer` IPC further
            //  down handles the opt-in offline-mode chat surface.)
            // Sesión 19 — local remediation pipeline
            ipc::remediation::start_remediation,
            ipc::remediation::apply_remediation,
            ipc::remediation::reject_remediation,
            ipc::remediation::get_remediation_session_cmd,
            // Sesión 20 — pre-push gate runner UI surface
            ipc::gates::get_recent_gate_runs,
            ipc::gates::request_bypass,
            // Sesión 27 — EAP receipt chip + Replay button
            ipc::eap::get_receipt_for_session,
            ipc::replay::replay_against_patch,
            // Sesión 28 — export receipt as `.eap.json`
            ipc::eap::export_eap_receipt,
            // Sesión 17 — sensor toggles + power-up stubs
            ipc::sensors::get_sensors_state,
            ipc::sensors::set_sensor_enabled,
            ipc::sensors::shell_hooks_status,
            ipc::sensors::install_shell_hooks,
            ipc::sensors::uninstall_shell_hooks,
            ipc::sensors::get_replay_enabled,
            ipc::sensors::set_replay_enabled,
            ipc::sensors::install_vscode_extension,
            ipc::sensors::configure_http_proxy,
            // v0.3 Phase A — read-only cloud-dashboard widget fetchers.
            // Each command emits `cloud-auth-required` on HTTP 401 so the
            // React panel can flip back to its "Reconnect" empty state.
            ipc::cloud::cloud_get_alerts,
            ipc::cloud::cloud_get_uptime,
            ipc::cloud::cloud_get_deploys,
            ipc::cloud::cloud_get_oncall,
            ipc::cloud::cloud_get_community_trending,
            ipc::cloud::cloud_get_status_summary,
            ipc::cloud::cloud_get_movie_manifest,
            ipc::cloud::cloud_get_trends,
            ipc::cloud::cloud_get_root_cause,
            ipc::cloud::cloud_ack_alert,
            ipc::cloud::cloud_silence_alert,
            // Inari Guard — `/test <path>` slash command. Reads local file
            // via project_local_path setting + POSTs to cloud test gen API.
            ipc::cloud::cloud_generate_test,
            // AlertDetailPanel (`Cmd+\` sidecar) — alert detail + timeline
            // + resolve quick action.
            ipc::cloud::cloud_get_alert_detail,
            ipc::cloud::cloud_get_alert_timeline,
            ipc::cloud::cloud_resolve_alert,
            // Inari Eye (visual bug report) — paired with alerts that have
            // source='user_report'. Renders screenshot + structured diagnosis.
            ipc::cloud::cloud_get_visual_report,
            // v0.3 S5 — Piper TTS local synthesis with synthetic-WAV fallback
            ipc::voice::voice_synthesize,
            ipc::voice::voice_list_voices,
            ipc::voice::voice_status,
            // S9 — Whisper STT + voice settings persistence
            ipc::voice::desktop_voice_capabilities,
            ipc::voice::desktop_voice_transcribe,
            ipc::voice::desktop_voice_get_settings,
            ipc::voice::desktop_voice_set_settings,
            // v0.3 S5 — Baileys WhatsApp sidecar control surface
            ipc::whatsapp::whatsapp_login_start,
            ipc::whatsapp::whatsapp_send,
            ipc::whatsapp::whatsapp_logout,
            ipc::whatsapp::whatsapp_list_accounts,
            ipc::whatsapp::whatsapp_status,
            // v0.3 S11 — audit-log viewer + per-tool permission settings.
            // Read-only over `tool_invocations` + the static
            // `agent::tools::catalog_all()`; the two `permission_*` setters
            // mutate the `Arc<PermissionResolver>` registered below in setup.
            // The `ToolRegistry` itself stays uninstantiated here — that's
            // explicitly S6's boot wire-up so this surface ships before
            // the live agent is online.
            ipc::audit_ui::desktop_audit_list,
            ipc::audit_ui::desktop_audit_get,
            ipc::audit_ui::desktop_audit_verify,
            ipc::audit_ui::desktop_permission_list,
            ipc::audit_ui::desktop_permission_set,
            ipc::audit_ui::desktop_permission_clear,
            // v0.3 S6 — chat-agent tool invocation surface. Reads
            // `Arc<ToolRegistry>` registered in setup() below; the
            // registry holds the 15 tools (S3 desktop_os + S4 local_exec
            // + S5 comm) and runs the audit/witness pipeline on every
            // call.
            ipc::tool_invoke::desktop_tool_invoke,
            ipc::tool_invoke::desktop_tool_confirm,
            ipc::tool_invoke::desktop_tool_invoke_via_slash,
            ipc::tool_invoke::desktop_tool_catalog,
            // v0.3 S8 — pairing primitive IPC. Drives Settings →
            // Channels (generate/list/revoke) and the SAS-confirm
            // modal (confirm). The redeem path is exclusively driven
            // by the messenger gateway, never exposed to the frontend.
            ipc::pairing::desktop_pairing_generate,
            ipc::pairing::desktop_pairing_list,
            ipc::pairing::desktop_whatsapp_list_paired,
            ipc::pairing::desktop_pairing_revoke,
            ipc::pairing::desktop_pairing_confirm,
            ipc::pairing::desktop_pairing_cleanup,
            // S12 — mobile-PWA pairing bridge IPC. Frontend Settings →
            // Channels → Mobile section calls these to mint a code and
            // forward the SAS confirm to web. The relay-side inbound
            // bridge lives in crate::messenger::mobile and lands once
            // the relay's reverse-direction publish endpoint ships.
            ipc::mobile_pairing::desktop_mobile_pairing_generate,
            ipc::mobile_pairing::desktop_mobile_pairing_confirm,
            // Inari Live V1 — Session 3 Add-Project wizard. Five thin
            // shells over `crate::wizard::{detect, install, dev}`. The
            // relay-driven auto-open ALSO uses these stores via
            // `relay_client::handle_dispatch_full_with_wizard`.
            ipc::wizard::wizard_get_pending,
            ipc::wizard::wizard_dismiss,
            ipc::wizard::wizard_detect_clone,
            ipc::wizard::wizard_run_install,
            ipc::wizard::wizard_run_dev,
            ipc::wizard::wizard_inject_test_event,
            // Inari Live V1 — Session 4. Tier 2 deeplink + clipboard.
            // Tier 3 snippets are rendered fully on the React side; the
            // copy command is shared between the two paths.
            ipc::wizard::wizard_copy_to_clipboard,
            ipc::wizard::wizard_open_host_dashboard,
            ipc::wizard::wizard_copy_project_token_to_clipboard,
            // Layer 1 — ONNX nearest-centroid semantic intent classifier.
            // L1: ONNX nearest-centroid (fastembed, offline, ~3-8ms warm).
            ipc::classify::classify_intent_semantic,
            // L2: Qwen zero-shot oracle via web /api/ai/classify (~200-500ms, requires connection).
            ipc::classify::classify_intent_l2,
            // Inari Live pure-slash Phase 2 — natural-language → slash
            // command translator. The single AI surface in the chat
            // input. Always returns Ok(vec![]) on failure so the UI
            // degrades to deterministic-only suggestions.
            ipc::slash::suggest_slash_commands,
            // Inari Live V1 — Session 5 conversations. CRUD + per-thread
            // SSE subscription. Workspace-level SSE auto-spawns in setup
            // below so the inbox stays live without an explicit subscribe.
            ipc::conversations::cloud_conversations_list,
            ipc::conversations::cloud_conversations_get,
            ipc::conversations::cloud_conversations_post_message,
            ipc::conversations::cloud_conversations_set_state,
            ipc::conversations::cloud_conversations_verify_chain,
            ipc::conversations::cloud_conversations_create_free,
            ipc::conversations::cloud_conversations_subscribe,
            ipc::conversations::cloud_conversations_unsubscribe,
            // Local LLM (Settings → AI → Local AI offline mode).
            // The commands are always registered; whether they use real
            // mistralrs or return a "not compiled" stub depends on the
            // `local-ai` feature (see ipc/local_ai.rs).
            ipc::local_ai::local_ai_load,
            ipc::local_ai::local_ai_infer,
            ipc::local_ai::local_ai_status,
            // Jarvis-layer user memory (Settings → Memory). Cross-session
            // personal fact store: identity, preferences, skills, patterns,
            // context. Rule-based extraction runs after each user turn.
            ipc::user_memory::user_memory_list,
            ipc::user_memory::user_memory_upsert,
            ipc::user_memory::user_memory_delete,
            ipc::user_memory::user_memory_wipe,
            ipc::user_memory::user_memory_rendered,
            ipc::user_memory::user_memory_extract,
            ipc::user_memory::user_memory_stats,
            // Inari Live Phase 5.2 — recent-paths buffer IPC for the
            // dock's path picker. Backs `/install` history + the
            // PathPickerSlot in Phase 5.6.
            ipc::recent_paths::desktop_recent_paths_list,
            ipc::recent_paths::desktop_recent_paths_add,
            // Inari Live Phase 5.5 completion — recent contacts buffer.
            // Backs the contact picker's "recent recipients" promotion.
            ipc::recent_contacts::desktop_recent_contacts_list,
            ipc::recent_contacts::desktop_recent_contacts_touch,
        ])
        .setup(|app| {
            // Tracing: rotating file appender at app_log_dir + 7-day
            // retention. Stored in State so the WorkerGuard lives as
            // long as the app (drop = lose tail-end logs).
            if let Some(guard) = init_tracing(&app.handle()) {
                app.manage(LoggingGuard(guard));
            }

            // Session 3 — local SQLite store. Migrations run synchronously
            // here (fail-fast). Session 4 — `store::install` also runs the
            // one-shot legacy TOML → SQL settings migration so the
            // SQL-backed command surface sees existing user data on first
            // post-Session-4 boot.
            let store = match store::install(&app.handle()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "store init failed");
                    return Err(Box::new(e) as Box<dyn std::error::Error>);
                }
            };

            // v0.3 S11 — chat-agent permission resolver. The settings UI
            // mutates this from a Tauri command (`desktop_permission_set`
            // / `desktop_permission_clear`). S6 picks the same Arc up
            // (via `app.state::<Arc<PermissionResolver>>()`) when
            // building the live `ToolRegistry`, so a settings-UI write
            // is observed by every subsequent registry invoke without
            // any wiring between the two.
            let permission_resolver: Arc<agent::PermissionResolver> =
                Arc::new(agent::PermissionResolver::new());
            app.manage(permission_resolver.clone());

            // Daemon: heartbeat every 30s, graceful shutdown drain 5s.
            let daemon_handle = Arc::new(daemon::start_daemon());
            app.manage(daemon_handle.clone());

            // Session 4 — wire the Bus → Tauri-event bridges. `daemon:event`
            // forwards every bus event 1:1; `daemon:status_changed` is
            // debounced to a 1s cadence with PartialEq dedup.
            ipc::events::start(app.handle().clone(), daemon_handle.clone());

            // Session 5 — Sensor 1 (FS watcher). The actor increments
            // `sensor_count` on spawn and decrements on Shutdown drain.
            // The handle is kept in tauri State so `open_repo` /
            // `close_repo` IPC commands attach/detach watchers per repo.
            let fs_sensor = sensors::fs::spawn_fs_sensor(
                daemon_handle.bus.clone(),
                daemon_handle.state.clone(),
            );
            app.manage(fs_sensor);

            // Session 7 — local MCP server (axum + JSON-RPC 2.0 on
            // 127.0.0.1:9876 with port fallback). Spawned async so the
            // Bearer token + chosen port are ready before the dock asks
            // the user "wire into your editor?". Bind failure is a soft
            // error: we log + continue without MCP (rather than blocking
            // the rest of startup) so the app still launches even on an
            // aggressively-firewalled box.
            //
            // Session 8 — git sensor mounts `/sensors/git/event` on the
            // same listener via `axum::Router::merge`. Token is loaded
            // from `<state_dir>/git_hook_token` (separate from the MCP
            // Bearer per the Session-8 token-separation decision).
            {
                let app_handle   = app.handle().clone();
                let daemon_clone = daemon_handle.clone();
                let store_clone  = store.clone();
                tauri::async_runtime::spawn(async move {
                    let git_router = match sensors::git::resolve_state_dir(&app_handle) {
                        Ok(state_dir) => match sensors::git::token::ensure_token(&state_dir) {
                            Ok(token) => {
                                // Sesión 20 — wire an OpenAI client into the
                                // hook state so Gate 5 (self-review) can run
                                // when the user has a key configured. Falls
                                // back to None silently when there's no key,
                                // making Gate 5 surface as `deferred`
                                // (push proceeds — the user can configure
                                // a key from Settings).
                                let openai = ai::openai::OpenAIClient::from_store(&store_clone).ok();
                                let hook_state = sensors::git::hooks::GitHookState {
                                    daemon: daemon_clone.clone(),
                                    store:  store_clone.clone(),
                                    token,
                                    openai,
                                };
                                Some(sensors::git::hooks::router(hook_state))
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "git_hook_token init failed");
                                None
                            }
                        },
                        Err(e) => {
                            tracing::warn!(error = %e, "git sensor state dir resolution failed");
                            None
                        }
                    };
                    let extras: Vec<axum::Router> = git_router.into_iter().collect();

                    match sensors::mcp::spawn_mcp_server_with_extras(
                        &app_handle,
                        daemon_clone.clone(),
                        store_clone.clone(),
                        extras,
                    ).await {
                        Ok(handle) => {
                            tracing::info!(
                                port = handle.port,
                                "MCP server ready"
                            );
                            app_handle.manage(std::sync::Arc::new(handle));
                            // Session 8 — bookkeeping task for the git
                            // sensor. The HTTP work runs on the MCP
                            // listener; this task only owns inc/dec
                            // sensor count + shutdown drain.
                            let _git_handle = sensors::git::spawn_git_sensor(
                                daemon_clone,
                                store_clone,
                            );
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "MCP server failed to start");
                        }
                    }
                });
            }

            // Session 6 — indexer. Subscribes to the daemon bus and
            // bootstraps embeddings on `RepoIndexed`, re-indexes on
            // `FsChange`, full re-walk on `ReindexRequested`. The
            // fastembed model cache lives under the same
            // `<app_local_data_dir>/inari-live/` tree the store + auth
            // files live under, so a clean uninstall removes it.
            if let Ok(local_dir) = app.path().app_local_data_dir() {
                indexer::set_cache_dir(local_dir.join("inari-live").join("models"));
            }
            let _indexer_handle = indexer::spawn_indexer(
                daemon_handle.clone(),
                store.clone(),
            );

            // Session 11 — declarative memory watcher. Subscribes to the
            // daemon bus for `RepoIndexed` (writes initial template) and
            // `MemoryReviewApproved` (records merge versions). The
            // returned handle is intentionally dropped here — the
            // watcher thread keeps itself alive via a channel
            // subscription and exits on `DaemonEvent::Shutdown`.
            let _memory_watcher = memory::declarative::spawn_memory_watcher(
                daemon_handle.clone(),
                store.clone(),
            );

            // Sesión 13 — episodic memory persister + retention runner.
            // The persister subscribes to the bus and writes the
            // persistable subset of `DaemonEvent` to the `events`
            // table; the retention runner ticks once an hour and drops
            // rows past their per-kind TTL (fs_change/shell_event/...
            // = 30 days; git_event = infinite). Both handles are
            // dropped here on purpose — the persister exits on
            // `Shutdown`, the retention runner exits when the runtime
            // is torn down at process exit. Retention's startup tick
            // is suppressed so first-launch boot doesn't pay an extra
            // DB write before any rows have aged out.
            let _episodic_persister = memory::episodic::spawn_event_persister(
                daemon_handle.clone(),
                store.clone(),
            );
            let _retention_runner = memory::retention::spawn_retention_runner(
                store.clone(),
            );

            // Sesión 12 — procedural learner. Subscribes to
            // `RemediationCompleted` + `FixRejected`, joins through
            // `remediation_sessions` for `(repo_id, fingerprint)`, and
            // updates `<repo_root>/.inari/patterns.json`. Emits
            // `PatternLearned` / `PatternDemoted` for the audit
            // trail. Spawned AFTER the episodic persister so the
            // `PatternLearned` / `PatternDemoted` events the learner
            // emits are picked up by the persister (subscribers see
            // events published AFTER subscription, so out-of-order
            // spawns risk dropped audit rows).
            let _pattern_learner = memory::procedural::spawn_pattern_learner(
                daemon_handle.clone(),
                store.clone(),
            );

            // Session 9 — Sensor 2 (shell hooks). Opens the per-platform
            // local socket (`~/.inari/sock/shell.sock` on Unix,
            // `\\.\pipe\inari-live-shell` on Windows). The listener is
            // harmless when no hooks are installed — no clients connect
            // and the bus gets no `ShellEvent`s. Bind failure (no
            // `$HOME`, permission denied, stale socket the
            // `try_overwrite` couldn't reclaim) logs at `warn` and
            // decrements `sensor_count`; rest of startup proceeds.
            let _shell_handle = sensors::shell::spawn(
                daemon_handle.clone(),
                store.clone(),
            );

            // Session 10 — Sensor 6 (Substrate replay correlation).
            // Subscribes to `FsChange::Modified` and asks the resolved
            // backend (local binary preferred, remote `/v2/replay`
            // fallback) whether the change preserves the recorded
            // behaviour of the most-recent `.inari/recordings/<id>/`.
            // The actor runs INERT when no backend is reachable — the
            // bus subscription stays alive (so `sensor_count` reports
            // honestly) but never publishes a `ReplayResult`. Per-repo
            // opt-in via the `replay_enabled` flag (migration 0004,
            // default OFF) means this sensor is silent for every repo
            // already in the user's store on upgrade. Track 2 closer.
            let _substrate_handle = sensors::substrate::spawn(
                daemon_handle.clone(),
                store.clone(),
            );

            setup_window(app)?;
            tray::install(app, daemon_handle.clone())?;

            // Global shortcut: Cmd+Space (Mac) / Ctrl+Space (Win/Linux)
            // toggles the dock window.
            register_global_shortcut(&app.handle());

            // ConnectState carries the spawned dev-server child so we can
            // kill it on disconnect / second connect.
            app.manage(Arc::new(cli::run::ConnectState::default()));

            // Legacy Session-0 "inari" window (visual prototype HTML at
            // dist/inari/index.html) is intentionally NOT auto-opened in v0.2 —
            // it pre-dates the Vite-served `dock.html` (S15) and `main.html`
            // (S17) and would 404 in dev mode (no Vite entry for inari/*).
            // The tray menu still exposes it via the "Open InariWatch" item
            // for users who want to reach the prototype manually.
            //
            // Pre-S17 call (kept for reference): open_inari_window(&app.handle().clone());

            // Background alert poller (extracted to cloud/alert_poller.rs).
            cloud::alert_poller::start(app.handle().clone(), store.clone());

            // v0.3 Phase A — SSE client for `/api/alerts/stream`. Forwards
            // events to the frontend via Tauri `cloud-alerts-update` so the
            // right-side dashboard panel refreshes without a polling loop
            // of its own. Survives token churn — re-reads creds each
            // iteration like the alert poller does.
            cloud::alert_stream::start(app.handle().clone(), store.clone());

            // Inari Live V1 — Session 5 conversation workspace SSE
            // consumer. Drives the sidebar inbox via `conversation:event`
            // (created / state). Per-conversation streams are opened on
            // demand via `cloud_conversations_subscribe`.
            cloud::conversations::start_workspace_stream(app.handle().clone(), store.clone());

            // Subscription state for per-conversation SSE handles.
            // Held in tauri::State so the IPC layer can spawn + cancel
            // without leaking tasks across user navigations.
            app.manage(Arc::new(ipc::conversations::ConversationSubscriptions::new()));

            // FS watcher + replay dispatcher. Session 5/10 owns the rewrite.
            inari_watcher::start(app.handle().clone());

            // Sesión 22 (v0.2) — LSP server on 127.0.0.1:9877.
            // Fail-OPEN: bind failure logs but does NOT abort the daemon.
            // Sesión 23 — wire LocalAI handle so the completion handler
            // can route through `LocalAI::generate(.., fim_mode = true)`.
            // LocalAI init failures are non-fatal: the LSP server still
            // starts and degrades to empty completions.
            //
            // Sesión 25 — register the LocalAI handle as Tauri-managed
            // state so the remediation IPC (`start_remediation`) can
            // read it for the Kortix FastApply-7B local path. Tauri
            // requires concrete `Option<T>` registration so consumers
            // pattern-match on `state.inner()`.
            let local_ai_handle = build_local_ai(&app.handle(), store.clone());
            app.manage::<Option<local_ai::LocalAI>>(local_ai_handle.clone());
            start_lsp_listener(local_ai_handle);

            // Local LLM chat inference (Settings → AI → Local AI).
            // Gated behind `local-ai` feature — disabled in test builds to
            // avoid mistralrs's native DLL requirements on Windows.
            #[cfg(feature = "local-ai")]
            app.manage::<std::sync::Arc<local_ai::chat_infer::LocalChatAI>>(
                std::sync::Arc::new(local_ai::chat_infer::LocalChatAI::new()),
            );

            // v0.3 S5 — boot the Baileys WhatsApp sidecar manager. It's
            // built unconditionally (so `Option<SidecarManager>` is
            // `Some` from the IPC perspective) but only spawns the Node
            // child process if `sidecars/whatsapp/dist/main.js` exists.
            // First-launch users with no Node installed see "WhatsApp
            // sidecar not running" if they try to send before the binary
            // is bundled. Per the v0.3 S5 brief, that's acceptable —
            // production builds bundle a Node runtime in a future
            // session; until then the dev path requires `node` on PATH.
            let whatsapp_mgr = build_whatsapp_manager(&app.handle());
            app.manage::<std::sync::Arc<whatsapp::SidecarManager>>(whatsapp_mgr.clone());
            // Wire the sidecar broadcast channel → Tauri events so the
            // frontend receives `whatsapp:qr-update` / `whatsapp:linked` etc.
            ipc::whatsapp::spawn_event_bridge(app.handle().clone(), whatsapp_mgr.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(err) = whatsapp_mgr.start().await {
                    tracing::warn!(error = %err, "[whatsapp] sidecar boot failed");
                    return;
                }
                // Re-issue `login_start` for every previously-paired account
                // dir under `auth_root`. The Baileys-side `useMultiFileAuthState`
                // picks up the existing creds.json + signal keys so the user
                // doesn't have to re-scan the QR on every restart. Failures
                // here log a warning and continue — a corrupt account dir
                // shouldn't gate boot.
                match whatsapp_mgr.resume_persisted_accounts().await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!("[whatsapp] resumed {n} paired account(s)"),
                    Err(err) => tracing::warn!(error = %err, "[whatsapp] resume failed"),
                }
            });

            // v0.3 S6 — chat-agent ToolRegistry. Built AFTER the WhatsApp
            // sidecar manager is registered (CommBackends::from_app
            // pulls the `Arc<SidecarManager>` from Tauri state) and
            // AFTER the SQLite store is online (AuditLog wraps the
            // shared pool).
            //
            // ReceiptSink stays in-memory (1024 cap) for S6 — explicit
            // follow-up tracked in the session prompt: persistent
            // sink (file or SQLite) lands in S6.5 / S11.5. The
            // in-memory sink is fine for production today because the
            // audit log carries the canonical `args_sha256`
            // content-addressed link via `witness_receipt_id`, so the
            // S11 verifier modal works without the sidecar.
            //
            // Per-cluster construct failures are NON-fatal: the boot
            // logs a warn and proceeds. Users see a partial tool
            // catalog (e.g. no `local.*` if no workspace_root)
            // instead of a dead chat surface.
            install_tool_registry(
                app.handle(),
                store.clone(),
                permission_resolver.clone(),
            );

            // S7 — single-slot store for "the alert the user just
            // saw". Populated by `notifications::show_alert_toast`
            // and read by tray Quick Actions. In-memory only; see
            // `last_alert.rs` for why we don't persist.
            app.manage::<Arc<notifications::LastAlertStore>>(Arc::new(
                notifications::LastAlertStore::new(),
            ));

            // v0.3 S8 — pairing service. Backs `Settings → Channels`
            // (generate codes, list paired phones, revoke) AND the
            // messenger gateway's DM-policy gate. SQLite via the
            // shared store pool; cleanup of expired rows happens on
            // the IPC `desktop_pairing_cleanup` command (frontend
            // schedules a periodic call). Single instance shared
            // across messenger gateway + IPC.
            let pairing_service = Arc::new(crate::pairing::PairingService::new(
                crate::pairing::PairingStore::new(store.pool().clone()),
            ));
            app.manage::<Arc<crate::pairing::PairingService>>(pairing_service);

            // S12 — register the MobileChannel placeholder + reserve
            // the messenger bus subscription for the relay's
            // `pair:sas-shown` events. The Gateway boot wiring itself
            // is shared with S8 / S10 — when those land their bus
            // we'll pass the broadcast::Sender into
            // `crate::messenger::handle_relay_pair_event` from the
            // relay frame dispatcher.
            //
            // Today the MobileChannel adapter is stateless — managing
            // it via app.manage<Arc<MobileChannel>> lets a future
            // Gateway::run pick it up alongside WhatsApp/Telegram/Slack.
            app.manage::<Arc<crate::messenger::MobileChannel>>(
                Arc::new(crate::messenger::MobileChannel::new()),
            );

            // Inari Live V1 — Session 3 wizard state. Two pieces:
            //   * WizardStore  — Mutex<Option<WizardPayload>> the relay
            //                    arm + IPC commands share.
            //   * RelayHandle  — owns the spawned relay client supervisor
            //                    so the bootstrap can replace it on
            //                    auth-status changes (login / logout).
            let wizard_store = crate::wizard::WizardStore::new();
            app.manage(wizard_store.clone());

            let relay_handle = crate::cloud::relay_bootstrap::RelayHandle::new();
            app.manage(relay_handle.clone());

            // Best-effort relay bootstrap. No-op when the user isn't
            // authenticated yet (the device-flow callback re-runs this
            // path post-pair via `cloud::auth::poll`'s persist hook —
            // tracked as a follow-up). For V1 the bootstrap fires
            // ON BOOT for already-paired installs, which covers the
            // happy path.
            {
                let app_handle = app.handle().clone();
                let store_clone = store.clone();
                let relay_clone = relay_handle.clone();
                let wizard_clone = wizard_store.clone();
                tauri::async_runtime::spawn(async move {
                    crate::cloud::relay_bootstrap::bootstrap_if_authenticated(
                        &app_handle,
                        &store_clone,
                        &relay_clone,
                        &wizard_clone,
                    ).await;
                });
            }

            // Boot-time workspace_id backfill — heals installs paired
            // before 4792b195. Without this, Channels pairing keeps
            // surfacing "no workspace selected" until the user logs
            // out + re-pairs. No-op when no token or workspace already
            // cached.
            {
                let store_clone = store.clone();
                tauri::async_runtime::spawn(async move {
                    crate::cloud::auth::backfill_workspace_if_missing(&store_clone).await;
                });
            }

            // Local Capture ingest server (was `local_ingest::start`)
            // moves to `sensors/substrate/local_ai/local_ingest.rs` (Session 10).
            // No spawn site here until that owner ships.
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray instead of closing
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error running InariWatch");
}

// ── Window ────────────────────────────────────────────────────────────────────

fn setup_window(app: &tauri::App) -> tauri::Result<()> {
    // In debug mode, load the local Inari Live main window (S17 onboarding +
    // settings React shell). Vite serves it at the devUrl in tauri.conf.json.
    // In release, point at the InariWatch web dashboard (api_url setting →
    // production fallback) so the bundled binary opens the user's cloud UI.
    let url = if cfg!(debug_assertions) {
        WebviewUrl::App("main.html".into())
    } else {
        let store = app.state::<Arc<store::Store>>();
        let raw = store::settings::get(&store, "api_url")
            .ok()
            .flatten()
            .unwrap_or_else(|| cloud::api::DEFAULT_API_URL.to_string());
        WebviewUrl::External(raw.parse().expect("invalid api_url in settings"))
    };

    WebviewWindowBuilder::new(app, "main", url)
        .title("Inari Live")
        // Linear-style frameless window — no native chrome / title bar.
        // The sidebar header carries `data-tauri-drag-region` so the user
        // can still drag the window from the top. macOS gets traffic-light
        // controls via `title_bar_style: Overlay` (handled per-OS by Tauri
        // when decorations are off). Close/minimise reachable via tray menu
        // and global shortcuts.
        .decorations(false)
        // Chat-first reframe (2026-05-07): a single conversation column
        // doesn't need 820px of vertical real estate. 720 reads as
        // "messaging app" rather than "dashboard"; on a 1366×768
        // laptop minus taskbar (~40 px) the whole window fits without
        // the bottom action row clipping. Min height 520 keeps it
        // usable when docked next to an editor.
        .inner_size(1280.0, 720.0)
        .min_inner_size(880.0, 520.0)
        .center()
        .visible(true)
        .build()?;

    Ok(())
}

// ── Inari Live window ─────────────────────────────────────────────────────────

pub(crate) fn open_inari_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(INARI_WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let result = WebviewWindowBuilder::new(
        app,
        INARI_WINDOW_LABEL,
        WebviewUrl::App("inari/index.html".into()),
    )
        .title("Inari Live")
        .inner_size(480.0, 640.0)
        .min_inner_size(420.0, 560.0)
        .max_inner_size(720.0, 960.0)
        .decorations(true)
        .transparent(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .resizable(true)
        .visible(true)
        .build();

    if let Err(e) = result {
        eprintln!("[inari-live] failed to open window: {}", e);
    }
}

// ── Tracing init ──────────────────────────────────────────────────────────────

/// RAII guard so the non-blocking writer keeps flushing while the app
/// is alive. Held in tauri State — dropped only at process exit.
#[allow(dead_code)]
struct LoggingGuard(tracing_appender::non_blocking::WorkerGuard);

fn init_tracing(app: &AppHandle) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let log_dir = match app.path().app_log_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[inari-live] could not resolve app_log_dir: {e}");
            return None;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("[inari-live] could not create log dir {}: {e}", log_dir.display());
        return None;
    }

    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("inari-live")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&log_dir)
        .ok()?;

    let (non_blocking, guard) = tracing_appender::non_blocking(appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_env("INARI_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .try_init();

    tracing::info!(
        log_dir = %log_dir.display(),
        "tracing initialized"
    );

    Some(guard)
}

// ── Global shortcut ───────────────────────────────────────────────────────────

fn register_global_shortcut(app: &AppHandle) {
    // Session 14 — dispatch table lives in window::shortcuts::register.
    let count = window::shortcuts::register(app);
    tracing::info!(count, "registered global shortcuts");
}

#[allow(dead_code)]
fn _silence_unused_shortcut_state() {
    // Keep ShortcutState in scope for the plugin handler.
    let _ = ShortcutState::Pressed;
}

// `pub(crate)` so `crate::tray::handle_menu_event` can dispatch the
// "Open InariWatch" item without re-implementing the toggle logic.
pub(crate) fn toggle_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main_window(app);
        }
    }
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Open the user's InariWatch dashboard in their default browser. Reads
/// `dashboard_url` from the SQL settings store; falls back to production
/// for users who haven't connected yet.
pub(crate) fn open_dashboard(app: &AppHandle) {
    let store = app.state::<Arc<store::Store>>();
    let base = store::settings::get(&store, "dashboard_url")
        .ok()
        .flatten()
        .or_else(|| store::settings::get(&store, "api_url").ok().flatten())
        .unwrap_or_else(|| cloud::api::DEFAULT_API_URL.to_string());
    let url = format!("{}/dashboard", base.trim_end_matches('/'));
    let _ = open_in_browser(&url);
}

// ── LSP listener bootstrap ───────────────────────────────────────────────────
//
// Sesión 22 (v0.2). Spawns the LSP server on 127.0.0.1:LSP_DEFAULT_PORT (9877).
// Distinct from the local MCP port (9876). Editors that speak stdio LSP
// connect via the `inari-lsp-stdio` sidecar binary, which proxies stdio ↔ TCP.
//
// Failure to bind (e.g. another instance already running) is logged but does
// NOT abort daemon startup — the dock + tray + alert poller stay functional.

fn start_lsp_listener(local_ai: Option<local_ai::LocalAI>) {
    tauri::async_runtime::spawn(async move {
        match lsp::start_lsp_server(LSP_DEFAULT_PORT).await {
            Ok((addr, state)) => {
                if let Some(ai) = local_ai {
                    state.set_local_ai(ai);
                    eprintln!("[lsp] listening on {addr} (LocalAI wired)");
                } else {
                    eprintln!("[lsp] listening on {addr} (no LocalAI — empty completions)");
                }
            }
            Err(e) => eprintln!("[lsp] failed to bind: {e}"),
        }
    });
}

/// v0.3 S5 — build the Baileys WhatsApp sidecar manager. Always returns
/// an Arc — the sidecar may or may not actually spawn (depends on whether
/// `node` is on PATH and `sidecars/whatsapp/dist/main.js` is built), and
/// failures surface lazily via `whatsapp_*` IPC commands rather than
/// failing app boot.
fn build_whatsapp_manager(
    app: &AppHandle,
) -> std::sync::Arc<whatsapp::SidecarManager> {
    let app_local_data = app.path().app_local_data_dir().ok();
    let resource_dir = app.path().resource_dir().ok();

    // Script lookup order:
    //   1. `<resource_dir>/sidecars/whatsapp/dist/main.js` (release bundle)
    //   2. `<repo>/desktop/src-tauri/sidecars/whatsapp/dist/main.js` (dev)
    //
    // Path #2 is computed relative to CARGO_MANIFEST_DIR at compile time
    // so dev runs from `cargo tauri dev` resolve correctly without
    // needing a release build of the sidecar.
    let script_path = resource_dir
        .as_ref()
        .map(|r| r.join("sidecars/whatsapp/dist/main.js"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| {
            let manifest_dir =
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest_dir.join("sidecars/whatsapp/dist/main.js")
        });

    let auth_root = app_local_data
        .map(|p| p.join("inari-live").join("whatsapp"))
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join("inari-live")
                .join("whatsapp")
        });

    let cfg = whatsapp::sidecar::SidecarConfig::new(script_path, auth_root);
    std::sync::Arc::new(whatsapp::SidecarManager::new(cfg))
}

/// v0.3 S6 — wire the chat-agent [`agent::ToolRegistry`] into Tauri
/// managed state. Pulls each cluster's backends, registers them, and
/// stashes both the registry and the in-memory receipt sink under
/// their `Arc<...>` types so IPC commands resolve via
/// `tauri::State<Arc<ToolRegistry>>`.
///
/// All four failure modes (audit ensure_schema, register_*) log a
/// warn and proceed:
///
/// - `AuditLog::ensure_schema()` — should always succeed (CREATE TABLE
///   IF NOT EXISTS), but if SQLite is in a wedged state we don't want
///   the dock to fail to boot. The IPC will return errors on every
///   invoke until the user restarts.
/// - `LocalExecBackends::from_app` returning `Err` — no `watch_dir`
///   set + no git repo at the process cwd. The chat surface sees a
///   subset of tools; the user can pick a watch dir from Settings to
///   unlock `local.*`.
/// - `CommBackends::from_app` returning `Err` — only happens if the
///   WhatsApp sidecar manager isn't registered yet, which is a logic
///   error (we register it just above this call). Defensive `warn`
///   surfaces the bug rather than panicking on a startup race.
/// - Cluster registration `Err(DuplicateTool)` — a programming error
///   (two clusters register the same name). Logged + the boot
///   continues with whatever did register.
fn install_tool_registry(
    app: &AppHandle,
    store: Arc<store::Store>,
    permission_resolver: Arc<agent::PermissionResolver>,
) {
    use agent::tools::{
        register_cloud_tools, // S6.5
        register_comm_tools, register_desktop_os_tools, register_local_exec_tools,
        register_search_tools, // S13
        register_setup_tools,  // setup.install_capture
    };
    use agent::tools::{
        CloudBackends, // S6.5
        CommBackends, DesktopOsBackends, LocalExecBackends,
        SearchToolBackends, // S13
        SetupBackends,      // setup.install_capture
    };
    use agent::{AuditLog, InMemoryReceiptSink, ToolRegistry, WitnessEmitter};

    let audit = Arc::new(AuditLog::new(store.pool().clone()));
    if let Err(e) = audit.ensure_schema() {
        tracing::warn!(error = %e, "[agent] AuditLog::ensure_schema failed; tool invocations will not persist");
    }

    let sink: Arc<InMemoryReceiptSink> = Arc::new(InMemoryReceiptSink::new(1024));
    let witness = Arc::new(WitnessEmitter::new(sink.clone()));
    let registry = Arc::new(ToolRegistry::new(
        permission_resolver,
        witness,
        audit.clone(),
    ));

    // Cluster 1 — desktop OS tools (S3). Backends always construct
    // (Tauri plugins are always available); failures here are
    // genuinely unexpected.
    let desktop_os = DesktopOsBackends::from_app(app.clone());
    if let Err(e) = register_desktop_os_tools(&registry, desktop_os) {
        tracing::warn!(error = %e, "[agent] register_desktop_os_tools failed");
    }

    // Cluster 2 — local exec tools (S4). May fail when no
    // `watch_dir` setting AND no git repo at cwd. The chat surface
    // gracefully shows a partial catalog.
    match LocalExecBackends::from_app(app.clone()) {
        Ok(local_exec) => {
            if let Err(e) = register_local_exec_tools(&registry, local_exec) {
                tracing::warn!(error = %e, "[agent] register_local_exec_tools failed");
            }
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "[agent] local exec backends unavailable — local.* tools will be missing from the chat catalog"
            );
        }
    }

    // Cluster 3 — comm tools (S5). Constructs from the Tauri-managed
    // SidecarManager + the dashboard creds; failure means the manager
    // wasn't registered yet (programming error, see fn doc).
    match CommBackends::from_app(app.clone()) {
        Ok(comm) => {
            if let Err(e) = register_comm_tools(&registry, comm) {
                tracing::warn!(error = %e, "[agent] register_comm_tools failed");
            }
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "[agent] comm backends unavailable — comm.* tools will be missing from the chat catalog"
            );
        }
    }

    // S13 — search cluster. The `inari_search::Searcher` is the only
    // backend dependency; it owns its own SQLite cache (under
    // `<app_local_data_dir>/inari-live/inari-search/`) and its own
    // reqwest client. The backend never blocks or panics on
    // construction — the only failure mode is a disk error creating
    // the cache dir, which we log + skip cluster registration. The
    // chat surface gracefully shows a partial catalog without
    // search.* in that case.
    let searcher_dir = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|p| p.join("inari-live").join("inari-search"));
    if let Some(dir) = searcher_dir {
        // `Searcher::new` is async (cache open + reqwest build).
        // `tauri::async_runtime::block_on` is the standard pattern
        // here — we're in the synchronous `setup()` callback and the
        // runtime is already initialized.
        let searcher_result = tauri::async_runtime::block_on(inari_search::Searcher::new(dir));
        match searcher_result {
            Ok(searcher) => {
                let backends = SearchToolBackends::from_searcher(Arc::new(searcher));
                if let Err(e) = register_search_tools(&registry, backends) {
                    tracing::warn!(error = %e, "[agent] register_search_tools failed");
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "[agent] inari-search Searcher unavailable — search.* tools will be missing from the chat catalog"
                );
            }
        }
    } else {
        tracing::warn!(
            "[agent] could not resolve app_local_data_dir for inari-search cache; search.* tools will be missing from the chat catalog"
        );
    }

    // setup cluster — chat-facing install_capture wraps the same 6-step
    // pipeline as `wizard_run_install`. Always succeeds construction
    // (no external deps beyond AppHandle + Store, both always present).
    {
        let backends = SetupBackends::from_app(app.clone(), store.clone());
        if let Err(e) = register_setup_tools(&registry, backends) {
            tracing::warn!(error = %e, "[agent] register_setup_tools failed");
        }
    }

    // Cluster — cloud workspace reads (S6.5). Wraps the shared
    // DesktopApiClient already used by comm.*, so re-login on the
    // Tauri side picks up the new bearer for cloud.* automatically.
    // Construction is infallible — the API client doesn't try to
    // resolve creds until a tool is invoked, which means an
    // unpaired desktop still surfaces the tools and the agent gets
    // an actionable "not paired" error message when called.
    {
        let backends = CloudBackends::from_app(app.clone());
        if let Err(e) = register_cloud_tools(&registry, backends) {
            tracing::warn!(error = %e, "[agent] register_cloud_tools failed");
        }
    }

    let count = registry.list().len();
    tracing::info!(count, "[agent] ToolRegistry online");

    app.manage(registry);
    app.manage(sink);
    // S7 — surface the audit log handle as managed state so the
    // tray's Quick Actions (and future ambient surfaces) can append
    // dismissal rows without re-creating an `AuditLog`.
    app.manage::<Arc<AuditLog>>(audit);
}

/// Sesión 23 — build the LocalAI facade. Non-fatal failure: returns
/// `None` and logs at `warn`. Sidecar binary resolution itself is lazy
/// (only triggered by the first `LocalAI::generate` call), so this only
/// fails if the registry can't initialise (typically a fs error in
/// `<store>/models/`).
fn build_local_ai(
    app: &AppHandle,
    store: Arc<store::Store>,
) -> Option<local_ai::LocalAI> {
    let resource_dir   = app.path().resource_dir().ok();
    let app_local_data = app.path().app_local_data_dir().ok();
    let paths = local_ai::SidecarPaths { resource_dir, app_local_data };
    match local_ai::LocalAI::new(store, paths) {
        Ok(ai) => Some(ai),
        Err(e) => {
            tracing::warn!(error = %e, "LocalAI init failed; LSP completions will be empty");
            None
        }
    }
}

fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no opener"))
}
